import { eq } from 'drizzle-orm'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import { dismissedKey } from '@shared/memory/dismissed'
import { scanNames } from '@shared/memory/nameScan'
import { matchPlan, type PlanSide, type SceneSide } from '@shared/memory/planMatch'
import { PLAN_LINKS_REASON_MAX, PLAN_LINKS_TEXT_MAX, type PlanRef } from '@shared/planLinks'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { searchableText } from '@shared/search'
import { AiCancelledError, AiFallbackError, AiProviderError } from '../../ai/providers/types'
import { cancelInflight } from '../../ai/inflight'
import { clearPlanMeta } from '../../ai/planLinks'
import { buildPlanLinksPromptV2, type BuiltPlanLinksPromptV2 } from '../../ai/prompts/planLinks.v2'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import { planLink } from '../../db/schema'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { getNode, type TreeDb } from '../../tree/treeStore'
import { dismiss, dismissedKeys } from '../dismissedStore'
import { listNameMentions, nameScanShared } from '../nameIndexer'
import { draftCards } from './cardStore'
import { claimSources } from './claimStore'
import {
  authorLink,
  boardOf,
  clip,
  insertLink,
  isDrafted,
  isPlanned,
  planLinkRows,
  prune,
  stands
} from './planLinkStore'

/**
 * Plan links applied automatically in story memory v2 (F-16.21, decision 2; plan P2a §5.2). A
 * planned scene (a manuscript scene with no words yet) is tied to the drafted scene that fulfils
 * it as derived index data: in `plan_link`, never in the scene metadata, marked as made by the
 * app, removable, and costed when the AI chose.
 *
 * After each reading (`linkPlansAfterReading`, called by the reader service with the reading's
 * id), code matches every open plan against the drafted scenes with a card (`matchPlan`: the
 * plan's title and synopsis against each scene's title, card line and gist, plus the records both
 * name): an unambiguous match is applied (`origin: 'code'`). When the best two are too close and
 * the reading moved the card line of one of them, `planLinks.v2` (fast, JSON, reasoning off)
 * picks between them: at most one call per reading, answered from the local cache when nothing
 * it reads changed. The author's links stay hers (`SceneMeta.fulfilledBy`): *Keep* makes an AI
 * link hers, *Unlink* takes any link off and sends the pair to Dismissed (`unlink`), so it is
 * never made again. Structure-template beats stay the author's (P2a-D12). A drafted scene
 * fulfils at most one plan here (decided by Claude, unconfirmed).
 */

const TITLE_MAX = 80

/** The records a plan's title and synopsis name for certain (the name scan's rules). */
function planRecords(index: ReturnType<typeof nameScanShared>, text: string): string[] {
  if (text.trim() === '') return []
  const mentions = scanNames([{ index: 0, text, from: 0, to: text.length }], index.index, {
    povRecordId: null,
    notMention: index.notMention
  })
  return [...new Set(mentions.filter((each) => !each.ambiguous).map((each) => each.recordId))]
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
  /** The request's reported cost as it returns (the Cloud monthly tally). */
  onSpend?: (usd: number) => void
}

export interface LinkPlansResult {
  /** Whether a link was made or one that no longer stood was dropped. */
  changed: boolean
  /** Whether `planLinks.v2` was asked (a cache hit counts as asked, at no cost). */
  asked: boolean
  costUsd: number
}

/**
 * Plan links after a reading (F-16.21): drops the links that no longer stand, applies every
 * unambiguous code match, and asks `planLinks.v2` about the first ambiguous best two one of whose
 * card lines this reading moved. Gated on Use AI and the Plan links switch (the code links too:
 * the switch is the author's say over all of it). A provider failure makes no link and fails
 * nothing; a stop of the reading's job stops the request.
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
  let changed = prune(db, board) > 0
  const stored = planLinkRows(db)
  const linkedPlans = new Set(stored.map((row) => row.planId))
  const taken = new Set([
    ...stored.map((row) => row.sceneId),
    ...board.docs.flatMap((row) => {
      const by = authorLink(board, row.id)
      return by === null ? [] : [by]
    })
  ])
  const sourceOf = claimSources(db, board.docs)
  const cards = new Map(draftCards(db, draftId).map((card) => [card.nodeId, card]))
  const scenes: SceneSide[] = board.docs.flatMap((row) => {
    const card = cards.get(row.id)
    if (!isDrafted(row) || sourceOf(row.id) !== 'scene' || card === undefined) return []
    if (card.line.trim() === '' || taken.has(row.id)) return []
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
  if (scenes.length === 0) return { ...none, changed }
  const names = nameScanShared(db)
  const unlinked = dismissedKeys(db, 'unlink')
  const now = new Date()
  let ambiguous: { plan: PlanSide; top: readonly [string, string]; score: number[] } | null = null
  const free = new Set(scenes.map((scene) => scene.id))
  for (const row of board.docs) {
    if (!isPlanned(row) || authorLink(board, row.id) !== null || linkedPlans.has(row.id)) continue
    const synopsis = board.metaOf.get(row.id)?.synopsis ?? ''
    const title = searchableText(row.title)
    const plan: PlanSide = {
      id: row.id,
      title,
      synopsis,
      records: planRecords(names, `${title}\n${synopsis}`)
    }
    const candidates = scenes.filter(
      (scene) =>
        free.has(scene.id) &&
        scene.id !== row.id &&
        !unlinked.has(dismissedKey({ kind: 'unlink', planId: row.id, sceneId: scene.id }))
    )
    const match = matchPlan(plan, candidates)
    if (match.kind === 'link') {
      insertLink(db, {
        planId: row.id,
        sceneId: match.sceneId,
        origin: 'code',
        score: match.score,
        reason: '',
        readingId: input.readingId,
        created: now.toISOString()
      })
      free.delete(match.sceneId)
      changed = true
    } else if (
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
  if (ambiguous === null) return { ...none, changed }
  const pair = ambiguous
  if (!pair.top.every((id) => free.has(id))) return { ...none, changed }
  const sceneOf = (id: string): SceneSide | undefined => scenes.find((scene) => scene.id === id)
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
  const answer = await askPlanLinks(deps, prompt, input)
  if (answer === null) return { changed, asked: false, costUsd: 0 }
  input.onSpend?.(answer.costUsd)
  const pick = answer.pick === 'S1' ? 0 : answer.pick === 'S2' ? 1 : null
  if (pick === null) return { changed, asked: true, costUsd: answer.costUsd }
  // Re-read: the request took a moment, and the author may have linked or written meanwhile.
  const fresh = boardOf(db)
  const sceneId = pair.top[pick]
  const planRow = fresh.byId.get(pair.plan.id)
  if (
    !isPlanned(planRow) ||
    authorLink(fresh, pair.plan.id) !== null ||
    planLinkRows(db).some((row) => row.planId === pair.plan.id || row.sceneId === sceneId) ||
    !isDrafted(fresh.byId.get(sceneId))
  ) {
    return { changed, asked: true, costUsd: answer.costUsd }
  }
  insertLink(db, {
    planId: pair.plan.id,
    sceneId,
    origin: 'ai',
    score: pair.score[pick] ?? 0,
    reason: clip(answer.why, PLAN_LINKS_REASON_MAX),
    readingId: input.readingId,
    created: new Date().toISOString()
  })
  return { changed: true, asked: true, costUsd: answer.costUsd }
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

/** One `planLinks.v2` request; null when it failed (nothing is linked, the reading stands). */
async function askPlanLinks(
  deps: AiRequestDeps,
  prompt: BuiltPlanLinksPromptV2,
  input: LinkPlansInput
): Promise<{ pick: 'S1' | 'S2' | 'none'; why: string; costUsd: number } | null> {
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
    const parsed = parsePlanLinksV2Answer(result.text)
    return parsed === null ? null : { ...parsed, costUsd: result.costUsd }
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
  if (row === undefined || !stands(board, row)) {
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
 * *Unlink* in v2 (F-16.21): a planned scene's automatic link leaves `plan_link`, or the author's
 * own link leaves its metadata; either way the pair goes to Dismissed (`unlink`), so code never
 * links it again (*Undo* there lets it). A beat is the author's (P2a-D12): it leaves its scene,
 * and nothing is dismissed (nothing links beats in v2). Answers the node whose metadata changed.
 */
export function unlinkPlanV2(db: TreeDb, plan: PlanRef, now: Date): { changedNodeIds: string[] } {
  if (plan.kind === 'beat') {
    const { changed } = clearPlanMeta(db, plan)
    return { changedNodeIds: changed === null ? [] : [changed] }
  }
  const row = db.select().from(planLink).where(eq(planLink.planId, plan.nodeId)).get()
  let sceneId: string | null
  let changed: string | null = null
  if (row !== undefined) {
    db.delete(planLink).where(eq(planLink.planId, plan.nodeId)).run()
    sceneId = row.sceneId
  } else {
    const cleared = clearPlanMeta(db, plan)
    sceneId = cleared.sceneId
    changed = cleared.changed
  }
  if (sceneId !== null) {
    const titleOf = (id: string): string =>
      searchableText(getNode(db, id)?.title ?? '').trim() || 'Untitled scene'
    dismiss(
      db,
      {
        kind: 'unlink',
        key: dismissedKey({ kind: 'unlink', planId: plan.nodeId, sceneId }),
        nodeId: plan.nodeId,
        label: `Plan link: ${titleOf(plan.nodeId)} fulfilled by ${titleOf(sceneId)}`
      },
      now
    )
  }
  return { changedNodeIds: changed === null ? [] : [changed] }
}
