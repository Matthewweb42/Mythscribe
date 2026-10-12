import { eq } from 'drizzle-orm'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import { scanNames } from '@shared/memory/nameScan'
import {
  matchPlan,
  planScore,
  qualifies,
  type PlanSide,
  type SceneSide
} from '@shared/memory/planMatch'
import { PLAN_LINKS_REASON_MAX, PLAN_LINKS_TEXT_MAX, type PlanRef } from '@shared/planLinks'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { searchableText } from '@shared/search'
import { AiCancelledError, AiFallbackError, AiProviderError } from '../../ai/providers/types'
import { cancelInflight } from '../../ai/inflight'
import { clearPlanMeta } from '../../ai/planLinks'
import { buildPlanLinksPromptV2, type BuiltPlanLinksPromptV2 } from '../../ai/prompts/planLinks.v2'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import { planLink, type NodeRow } from '../../db/schema'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { getNode, type TreeDb } from '../../tree/treeStore'
import { dismiss, dismissedKeys } from '../dismissedStore'
import { listNameMentions, nameScanShared } from '../nameIndexer'
import { draftCards } from './cardStore'
import {
  authorLink,
  boardOf,
  clip,
  deleteLink,
  insertLink,
  isDrafted,
  isPlanned,
  planLinkRows,
  prune,
  stands
} from './planLinkStore'
import { getUnlinkedStash, setUnlinkedStash, type UnlinkedLink } from './readerRows'

/**
 * Plan links applied automatically in story memory v2 (F-16.21, decision 2; plan P2a §5.2). A
 * planned scene (a manuscript scene with no words yet) is tied to the drafted scene that fulfils
 * it as derived index data: in `plan_link`, never in the scene metadata, marked as made by the
 * app, removable, and costed when the AI chose.
 *
 * After each reading (`linkPlansAfterReading`, called by the reader service with the reading's
 * id), code matches every open plan against the drafted, readable scenes with a card
 * (`matchPlan`: the plan's title and synopsis against each scene's title, card line and gist, plus
 * the records both name). Code links are matched again on every pass, from the cards as they are
 * now: one a better scene has since overtaken is moved, one that has turned too close to call is
 * taken off (and may go to the AI), so the first scene read never keeps a plan for good. When the
 * best two are too close and the reading moved the card line of one of them, `planLinks.v2`
 * (fast, JSON, reasoning off) picks between them: at most one call per reading, answered from the
 * local cache when nothing it reads changed. An AI pick stays until it no longer stands, or until
 * a reading moves its scene's card line and that scene no longer qualifies at all. The author's
 * links stay hers (`SceneMeta.fulfilledBy`): *Keep* makes an AI link hers, *Unlink* takes any link
 * off and sends the pair to Dismissed (`unlink`), so it is never made again, and the unlinked
 * scene still ranks, so the runner-up is never linked in its place; *Undo* there puts the link
 * back. Links are per draft: only the active draft's stand. Structure-template beats stay the
 * author's (P2a-D12). A drafted scene fulfils at most one plan here (decided by Claude,
 * unconfirmed).
 */

const TITLE_MAX = 80

/** The records a plan's title and synopsis name for certain, and the words that named them. */
function planNames(
  index: ReturnType<typeof nameScanShared>,
  text: string
): { records: string[]; names: string[] } {
  if (text.trim() === '') return { records: [], names: [] }
  const mentions = scanNames([{ index: 0, text, from: 0, to: text.length }], index.index, {
    povRecordId: null,
    notMention: index.notMention
  }).filter((each) => !each.ambiguous)
  return {
    records: [...new Set(mentions.map((each) => each.recordId))],
    names: [...new Set(mentions.map((each) => each.text))]
  }
}

export interface LinkPlansInput {
  /** The project's AI settings (Use AI and the Plan links switch gate everything here). */
  settings: AiSettings
  /** The reading that just wrote (its id goes on every link it makes). */
  readingId: string
  /** The scene it read. */
  nodeId: string
  /** Whether the reading moved that scene's card line (`card.line_hash`): only then may the AI be asked. */
  lineMoved: boolean
  /** The reading job's id; the plan-link request registers as `<requestId>:p`. */
  requestId: string
  signal?: AbortSignal
  /** False: code links only, `planLinks.v2` is not asked (the Cloud cap is reached). Default true. */
  askAi?: boolean
  /** Each billed request's reported cost as it returns (the Cloud monthly tally). */
  onSpend?: (usd: number) => void
}

export interface LinkPlansResult {
  /** Whether a link was made, moved, or one that no longer stood was dropped. */
  changed: boolean
  /** Whether `planLinks.v2` was asked (a cache hit counts as asked, at no cost). */
  asked: boolean
  costUsd: number
}

/**
 * Plan links after a reading (F-16.21): drops the links that no longer stand, matches every open
 * plan again (applying each unambiguous code match, moving or taking off a code link the cards no
 * longer bear out), and asks `planLinks.v2` about the first ambiguous best two one of whose card
 * lines this reading moved. Gated on Use AI and the Plan links switch (the code links too: the
 * switch is the author's say over all of it). A provider failure makes no link and fails nothing;
 * a stop of the reading's job stops the request.
 */
export async function linkPlansAfterReading(
  db: TreeDb,
  deps: AiRequestDeps,
  input: LinkPlansInput
): Promise<LinkPlansResult> {
  const none: LinkPlansResult = { changed: false, asked: false, costUsd: 0 }
  if (!isFeatureAllowed(input.settings, 'planLinks')) return none
  const draftId = currentDraftId(db)
  if (draftId === null) return none
  const board = boardOf(db)
  let changed = prune(db, board, draftId) > 0
  // After the prune every row of the active draft stands.
  const live = new Map(
    planLinkRows(db)
      .filter((row) => row.draftId === draftId)
      .map((row) => [row.planId, row])
  )
  const cards = new Map(draftCards(db, draftId).map((card) => [card.nodeId, card]))
  const scenes: SceneSide[] = board.docs.flatMap((row) => {
    const card = cards.get(row.id)
    if (!isDrafted(row) || !board.readable(row.id) || card === undefined) return []
    if (card.line.trim() === '') return []
    const records = [
      ...new Set(
        listNameMentions(db, row.id)
          .filter((each) => !each.ambiguous)
          .map((each) => each.recordId)
      )
    ]
    return [
      { id: row.id, title: searchableText(row.title), line: card.line, gist: card.gist, records }
    ]
  })
  const sceneOf = (id: string): SceneSide | undefined => scenes.find((scene) => scene.id === id)
  const names = nameScanShared(db)
  const planOf = (row: NodeRow): PlanSide => {
    const synopsis = board.metaOf.get(row.id)?.synopsis ?? ''
    const title = searchableText(row.title)
    return { id: row.id, title, synopsis, ...planNames(names, `${title}\n${synopsis}`) }
  }
  // An AI pick whose scene's card line this reading moved is checked again: one the scene no
  // longer bears out at all goes, and the plan is matched afresh below.
  for (const row of live.values()) {
    if (row.origin !== 'ai' || !input.lineMoved || row.sceneId !== input.nodeId) continue
    const planRow = board.byId.get(row.planId)
    const scene = sceneOf(row.sceneId)
    if (
      planRow !== undefined &&
      scene !== undefined &&
      qualifies(planScore(planOf(planRow), scene))
    )
      continue
    deleteLink(db, row.planId)
    live.delete(row.planId)
    changed = true
  }
  // Held for good this pass: the author's links' scenes and the AI's picks. Code links are
  // matched again, plan by plan in reading order, each scene going to the first plan it fits.
  const taken = new Set([
    ...[...live.values()].filter((row) => row.origin === 'ai').map((row) => row.sceneId),
    ...board.docs.flatMap((row) => {
      const by = authorLink(board, row.id)
      return by === null ? [] : [by]
    })
  ])
  const unlinked = dismissedKeys(db, 'unlink')
  const now = new Date()
  let ambiguous: { plan: PlanSide; top: readonly [string, string]; score: number[] } | null = null
  for (const row of board.docs) {
    if (!isPlanned(row) || authorLink(board, row.id) !== null) continue
    const held = live.get(row.id)
    if (held?.origin === 'ai') continue
    if (scenes.length === 0 && held === undefined) continue
    const plan = planOf(row)
    const candidates = scenes.filter((scene) => !taken.has(scene.id) && scene.id !== row.id)
    // A scene the author unlinked from this plan ranks, so its runner-up is not linked instead.
    const blocked = new Set(
      candidates
        .filter((scene) =>
          unlinked.has(dismissedKey({ kind: 'unlink', planId: row.id, sceneId: scene.id }))
        )
        .map((scene) => scene.id)
    )
    const match = matchPlan(plan, candidates, blocked)
    if (match.kind === 'link') {
      taken.add(match.sceneId)
      if (held?.sceneId === match.sceneId) continue
      insertLink(db, {
        planId: row.id,
        sceneId: match.sceneId,
        origin: 'code',
        score: match.score,
        reason: '',
        readingId: input.readingId,
        created: now.toISOString(),
        draftId
      })
      changed = true
      continue
    }
    if (held !== undefined) {
      deleteLink(db, row.id)
      changed = true
    }
    if (
      match.kind === 'ambiguous' &&
      ambiguous === null &&
      input.lineMoved &&
      match.top.some((each) => each.sceneId === input.nodeId)
    ) {
      ambiguous = {
        plan,
        top: [match.top[0].sceneId, match.top[1].sceneId],
        score: [match.top[0].score, match.top[1].score]
      }
    }
  }
  if (ambiguous === null || input.askAi === false) return { ...none, changed }
  const pair = ambiguous
  // A later plan's code link may have taken one of the two meanwhile.
  if (pair.top.some((id) => taken.has(id))) return { ...none, changed }
  const first = sceneOf(pair.top[0])
  const second = sceneOf(pair.top[1])
  if (first === undefined || second === undefined) return { ...none, changed }
  const prompt = buildPlanLinksPromptV2({
    plan: {
      title: clip(pair.plan.title, TITLE_MAX),
      synopsis: clip(pair.plan.synopsis, PLAN_LINKS_TEXT_MAX)
    },
    scenes: [
      { title: clip(first.title, TITLE_MAX), line: first.line, gist: first.gist },
      { title: clip(second.title, TITLE_MAX), line: second.line, gist: second.gist }
    ]
  })
  const reply = await askPlanLinks(deps, prompt, input)
  if (reply === null) return { changed, asked: false, costUsd: 0 }
  // A billed reply counts toward the tally whether or not it reads.
  input.onSpend?.(reply.costUsd)
  const answer = reply.answer
  const pick = answer?.pick === 'S1' ? 0 : answer?.pick === 'S2' ? 1 : null
  if (answer === null || pick === null) return { changed, asked: true, costUsd: reply.costUsd }
  // Re-read: the request took a moment, and the author may have linked or written meanwhile.
  const fresh = boardOf(db)
  const sceneId = pair.top[pick]
  const planRow = fresh.byId.get(pair.plan.id)
  if (
    currentDraftId(db) !== draftId ||
    !isPlanned(planRow) ||
    authorLink(fresh, pair.plan.id) !== null ||
    planLinkRows(db).some(
      (row) => row.draftId === draftId && (row.planId === pair.plan.id || row.sceneId === sceneId)
    ) ||
    !isDrafted(fresh.byId.get(sceneId)) ||
    !fresh.readable(sceneId)
  ) {
    return { changed, asked: true, costUsd: reply.costUsd }
  }
  insertLink(db, {
    planId: pair.plan.id,
    sceneId,
    origin: 'ai',
    score: pair.score[pick] ?? 0,
    reason: clip(answer.why, PLAN_LINKS_REASON_MAX),
    readingId: input.readingId,
    created: new Date().toISOString(),
    draftId
  })
  return { changed: true, asked: true, costUsd: reply.costUsd }
}

/** The model's `{ pick, why }`, or null for an answer that does not read (no link then). */
export function parsePlanLinksV2Answer(
  text: string
): { pick: 'S1' | 'S2' | 'none'; why: string } | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const entry = json as Record<string, unknown>
  const raw = typeof entry.pick === 'string' ? entry.pick.trim().toUpperCase() : ''
  const pick = raw === 'S1' || raw === 'S2' ? raw : raw === 'NONE' ? 'none' : null
  if (pick === null) return null
  return { pick, why: typeof entry.why === 'string' ? entry.why : '' }
}

/**
 * One `planLinks.v2` request: the parsed answer (null for a reply that does not read: no link)
 * with the reply's cost, or null when the request failed (nothing billed, nothing linked).
 */
async function askPlanLinks(
  deps: AiRequestDeps,
  prompt: BuiltPlanLinksPromptV2,
  input: LinkPlansInput
): Promise<{
  answer: { pick: 'S1' | 'S2' | 'none'; why: string } | null
  costUsd: number
} | null> {
  if (input.signal?.aborted === true) throw new AiCancelledError('Linking plans was stopped.')
  const childId = `${input.requestId}:p`
  const onAbort = (): void => void cancelInflight(childId)
  input.signal?.addEventListener('abort', onAbort)
  try {
    const result = await runAiRequest(deps, {
      feature: 'planLinks',
      tier: 'fast',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(prompt.messages)),
      promptVersion: prompt.version,
      requestId: childId
    })
    return { answer: parsePlanLinksV2Answer(result.text), costUsd: result.costUsd }
  } catch (err) {
    if (err instanceof AiCancelledError) throw err
    if (err instanceof AiProviderError || err instanceof AiFallbackError) return null
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * *Keep* (F-16.21): the automatic link of a planned scene becomes the author's (`fulfilledBy`)
 * and leaves `plan_link`. NOT_FOUND when the plan has no automatic link. Answers the node whose
 * metadata it rewrote.
 */
export function keepPlanLink(db: TreeDb, planId: string): { changedNodeIds: string[] } {
  const row = db.select().from(planLink).where(eq(planLink.planId, planId)).get()
  const board = boardOf(db)
  if (row === undefined || !stands(board, row, currentDraftId(db))) {
    throw new AppError('NOT_FOUND', 'That plan has no automatic link to keep', { planId })
  }
  const meta = board.metaOf.get(planId) ?? parseStoredSceneMeta(null)
  db.transaction((tx) => {
    setSceneMeta(tx, planId, { ...meta, fulfilledBy: row.sceneId })
    tx.delete(planLink).where(eq(planLink.planId, planId)).run()
  })
  return { changedNodeIds: [planId] }
}

/**
 * *Unlink* in v2 (F-16.21): a planned scene's automatic link (the active draft's) leaves
 * `plan_link`, or the author's own link leaves its metadata; either way the pair goes to Dismissed
 * (`unlink`), so code never links it again, and the link taken off is kept by the Dismissed row's
 * id, so *Undo* there puts it back (`restoreUnlinked`). A beat is the author's (P2a-D12): it
 * leaves its scene, and nothing is dismissed (nothing links beats in v2). Answers the node whose
 * metadata changed.
 */
export function unlinkPlanV2(db: TreeDb, plan: PlanRef, now: Date): { changedNodeIds: string[] } {
  if (plan.kind === 'beat') {
    const { changed } = clearPlanMeta(db, plan)
    return { changedNodeIds: changed === null ? [] : [changed] }
  }
  const stored = db.select().from(planLink).where(eq(planLink.planId, plan.nodeId)).get()
  const row = stored?.draftId === currentDraftId(db) ? stored : undefined
  let sceneId: string | null
  let changed: string | null = null
  let link: UnlinkedLink
  if (row !== undefined) {
    deleteLink(db, plan.nodeId)
    sceneId = row.sceneId
    link = {
      origin: row.origin,
      score: row.score,
      reason: row.reason,
      readingId: row.readingId,
      draftId: row.draftId,
      created: row.created
    }
  } else {
    const cleared = clearPlanMeta(db, plan)
    sceneId = cleared.sceneId
    changed = cleared.changed
    link = { origin: 'author' }
  }
  if (sceneId !== null) {
    const titleOf = (id: string): string =>
      searchableText(getNode(db, id)?.title ?? '').trim() || 'Untitled scene'
    const entry = dismiss(
      db,
      {
        kind: 'unlink',
        key: dismissedKey({ kind: 'unlink', planId: plan.nodeId, sceneId }),
        nodeId: plan.nodeId,
        label: `Plan link: ${titleOf(plan.nodeId)} fulfilled by ${titleOf(sceneId)}`
      },
      now
    )
    setUnlinkedStash(db, { ...getUnlinkedStash(db), [entry.id]: link })
  }
  return { changedNodeIds: changed === null ? [] : [changed] }
}

/**
 * *Undo* of an *Unlink* in Dismissed (F-16.21; answer 22): the link goes back as it was, the
 * author's into `fulfilledBy`, an automatic one into `plan_link`, when the plan is still planned
 * with no link of its own and the scene is still there. A link that cannot go back (the plan has
 * words or another link now, or the stash has no entry) is simply not restored: the next reading
 * matches the plan again, the pair no longer dismissed. Answers the nodes whose metadata changed
 * and whether the automatic links changed.
 */
export function restoreUnlinked(
  db: TreeDb,
  undone: Pick<Dismissed, 'id' | 'key'>
): { changedNodeIds: string[]; linksChanged: boolean } {
  const stash = getUnlinkedStash(db)
  const link = stash[undone.id]
  if (link !== undefined) {
    setUnlinkedStash(
      db,
      Object.fromEntries(Object.entries(stash).filter(([id]) => id !== undone.id))
    )
  }
  const cut = undone.key.indexOf('|')
  const planId = undone.key.slice(0, cut)
  const sceneId = undone.key.slice(cut + 1)
  const board = boardOf(db)
  const nothing = { changedNodeIds: [], linksChanged: false }
  if (link === undefined || cut < 0 || !isPlanned(board.byId.get(planId))) return nothing
  if (!board.byId.has(sceneId) || authorLink(board, planId) !== null) return nothing
  const draftId = currentDraftId(db)
  const current = planLinkRows(db).find((row) => row.planId === planId)
  if (current !== undefined && stands(board, current, draftId)) return nothing
  if (link.origin === 'author') {
    const meta = board.metaOf.get(planId) ?? parseStoredSceneMeta(null)
    db.transaction((tx) => {
      setSceneMeta(tx, planId, { ...meta, fulfilledBy: sceneId })
      tx.delete(planLink).where(eq(planLink.planId, planId)).run()
    })
    return { changedNodeIds: [planId], linksChanged: current !== undefined }
  }
  // An automatic link belongs to the draft it was made in; one from another draft waits there.
  if (planLinkRows(db).some((row) => row.sceneId === sceneId && row.draftId === link.draftId)) {
    return nothing
  }
  insertLink(db, {
    planId,
    sceneId,
    origin: link.origin,
    score: link.score,
    reason: link.reason,
    readingId: link.readingId,
    created: link.created,
    draftId: link.draftId
  })
  return { changedNodeIds: [], linksChanged: true }
}
