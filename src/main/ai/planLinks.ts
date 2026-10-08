import {
  PLAN_LINKS_PLANS_MAX,
  PLAN_LINKS_REASON_MAX,
  PLAN_LINKS_SCENES_MAX,
  PLAN_LINKS_SUGGESTIONS_MAX,
  PLAN_LINKS_TEXT_MAX,
  planKey,
  planLinkKey,
  withKey,
  type PlanLinkState,
  type PlanLinkSuggestion,
  type PlanLinkView,
  type PlanLinksRunResult,
  type PlanRef
} from '@shared/planLinks'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { STRUCTURE_TEMPLATES, type StructureTemplateId } from '@shared/structure'
import type { NodeRow } from '../db/schema'
import { setSceneMeta } from '../document/sceneMetaStore'
import { summariesFor } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import {
  getAiSettings,
  getPlanLinkState,
  getProjectStructure,
  setPlanLinkState
} from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptRows } from './context/storyTime'
import { assertFeatureAllowed } from './dial'
import {
  buildPlanLinksPrompt,
  type PlanLinkPlanLine,
  type PlanLinkSceneLine
} from './prompts/planLinks.v1'
import { AiFallbackError } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/** A title as the prompt sends it. */
const TITLE_MAX = 80

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * The project as plan links see it (F-11.1d): the manuscript documents in reading order with
 * their metadata, the structure template, which plans are open, and which written scenes exist.
 */
interface PlanBoard {
  documents: NodeRow[]
  metaOf: Map<string, SceneMeta>
  template: StructureTemplateId | null
  /** A planned document is open while it has no text and no link to a document that exists. */
  isOpen: (plan: PlanRef) => boolean
  isWritten: (nodeId: string) => boolean
}

function planBoard(db: TreeDb): PlanBoard {
  const manuscript = manuscriptRows(listNodes(db))
  const documents = manuscript.filter((row) => row.kind === 'document')
  const ids = new Set(documents.map((row) => row.id))
  const metaOf = new Map(manuscript.map((row) => [row.id, parseStoredSceneMeta(row.sceneMeta)]))
  const template = getProjectStructure(db).template
  const byId = new Map(documents.map((row) => [row.id, row]))
  const isWritten = (nodeId: string): boolean => (byId.get(nodeId)?.wordCount ?? 0) > 0
  const isOpen = (plan: PlanRef): boolean => {
    if (plan.kind === 'scene') {
      const row = byId.get(plan.nodeId)
      const linked = metaOf.get(plan.nodeId)?.fulfilledBy
      const fulfilled = linked !== undefined && ids.has(linked)
      return row?.wordCount === 0 && !fulfilled
    }
    if (plan.template !== template) return false
    if (
      !STRUCTURE_TEMPLATES[plan.template].acts.some((act) =>
        act.beats.some((b) => b.id === plan.beatId)
      )
    ) {
      return false
    }
    return ![...metaOf.values()].some((meta) => meta.beats[plan.template] === plan.beatId)
  }
  return { documents, metaOf, template, isOpen, isWritten }
}

/** Whether a suggestion still stands: its plan is open and its scene is written and free for it. */
function stillValid(board: PlanBoard, link: PlanLinkSuggestion): boolean {
  if (!board.isOpen(link.plan) || !board.isWritten(link.sceneId)) return false
  if (link.plan.kind === 'beat') {
    return board.metaOf.get(link.sceneId)?.beats[link.plan.template] === undefined
  }
  return link.plan.nodeId !== link.sceneId
}

/** What the outline reads: the suggestions that still stand, and the links the AI applied. */
export function getPlanLinks(db: TreeDb): PlanLinkView {
  const state = getPlanLinkState(db)
  const board = planBoard(db)
  return {
    suggestions: state.suggestions.filter((link) => stillValid(board, link)),
    aiApplied: state.aiApplied
  }
}

/** What one request is about, with the labels the model answers in. */
interface PlanLinkRequest {
  plans: { line: PlanLinkPlanLine; plan: PlanRef }[]
  scenes: { line: PlanLinkSceneLine; nodeId: string }[]
}

/**
 * The open plans and the written scenes with a stored summary (F-5.6), capped (token rule 2):
 * planned scenes in reading order, then the template's empty beats in story order; written
 * scenes not yet tied to any plan first, then the rest, each group in reading order. Null when
 * there is no open plan or no summarized written scene: nothing to ask.
 */
function planLinkRequest(
  db: TreeDb,
  board: PlanBoard,
  dismissed: ReadonlySet<string>
): PlanLinkRequest | null {
  const plans: PlanRef[] = board.documents
    .filter((row) => board.isOpen({ kind: 'scene', nodeId: row.id }))
    .map((row) => ({ kind: 'scene' as const, nodeId: row.id }))
  if (board.template !== null) {
    const template = board.template
    for (const act of STRUCTURE_TEMPLATES[template].acts) {
      for (const beat of act.beats) {
        const plan: PlanRef = { kind: 'beat', template, beatId: beat.id }
        if (board.isOpen(plan)) plans.push(plan)
      }
    }
  }
  const written = board.documents.filter((row) => row.wordCount > 0)
  const summaries = summariesFor(
    db,
    written.map((row) => row.id)
  )
  const linked = new Set(
    [...board.metaOf.values()].flatMap((meta) =>
      meta.fulfilledBy === undefined ? [] : [meta.fulfilledBy]
    )
  )
  const free = (row: NodeRow): boolean =>
    !linked.has(row.id) &&
    (board.template === null || board.metaOf.get(row.id)?.beats[board.template] === undefined)
  const candidates = [
    ...written.filter((row) => summaries.has(row.id) && free(row)),
    ...written.filter((row) => summaries.has(row.id) && !free(row))
  ].slice(0, PLAN_LINKS_SCENES_MAX)
  // A plan every candidate scene was dismissed for has nothing left to ask.
  const askable = plans
    .filter((plan) =>
      candidates.some((row) => !dismissed.has(planLinkKey({ plan, sceneId: row.id })))
    )
    .slice(0, PLAN_LINKS_PLANS_MAX)
  if (askable.length === 0 || candidates.length === 0) return null

  const titleOf = new Map(board.documents.map((row) => [row.id, row.title]))
  return {
    plans: askable.map((plan, index) => {
      const label = `P${index + 1}`
      if (plan.kind === 'scene') {
        return {
          plan,
          line: {
            label,
            kind: 'scene',
            title: clip(titleOf.get(plan.nodeId) ?? '', TITLE_MAX),
            text: clip(board.metaOf.get(plan.nodeId)?.synopsis ?? '', PLAN_LINKS_TEXT_MAX)
          }
        }
      }
      const beat = STRUCTURE_TEMPLATES[plan.template].acts
        .flatMap((act) => act.beats)
        .find((each) => each.id === plan.beatId)
      return {
        plan,
        line: {
          label,
          kind: 'beat',
          title: clip(beat?.name ?? plan.beatId, TITLE_MAX),
          text: clip(beat?.hint ?? '', PLAN_LINKS_TEXT_MAX)
        }
      }
    }),
    scenes: candidates.map((row, index) => ({
      nodeId: row.id,
      line: {
        label: `S${index + 1}`,
        title: clip(row.title, TITLE_MAX),
        summary: clip(summaries.get(row.id)?.summary ?? '', PLAN_LINKS_TEXT_MAX)
      }
    }))
  }
}

/**
 * The model's `{ links: [...] }` against the labels sent: PROVIDER when it is not JSON or has no
 * `links` array; lenient link by link otherwise. A link naming an unknown label, a dismissed
 * pair, a plan already linked in this answer, or a scene already given a beat is dropped.
 */
export function parsePlanLinksAnswer(
  text: string,
  request: PlanLinkRequest,
  dismissed: ReadonlySet<string>
): PlanLinkSuggestion[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError('The model did not answer in the expected format.', err)
  }
  const links =
    typeof json === 'object' && json !== null && Array.isArray((json as { links?: unknown }).links)
      ? (json as { links: unknown[] }).links
      : null
  if (links === null) throw new AiFallbackError('The model did not answer in the expected format.')
  const plans = new Map(request.plans.map((each) => [each.line.label.toLowerCase(), each.plan]))
  const scenes = new Map(request.scenes.map((each) => [each.line.label.toLowerCase(), each.nodeId]))
  const out: PlanLinkSuggestion[] = []
  const usedPlans = new Set<string>()
  const beatScenes = new Set<string>()
  for (const raw of links) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const plan =
      typeof entry.plan === 'string' ? plans.get(entry.plan.trim().toLowerCase()) : undefined
    const sceneId =
      typeof entry.scene === 'string' ? scenes.get(entry.scene.trim().toLowerCase()) : undefined
    if (plan === undefined || sceneId === undefined) continue
    if (plan.kind === 'scene' && plan.nodeId === sceneId) continue
    const key = planLinkKey({ plan, sceneId })
    if (dismissed.has(key) || usedPlans.has(planKey(plan))) continue
    if (plan.kind === 'beat' && beatScenes.has(sceneId)) continue
    usedPlans.add(planKey(plan))
    if (plan.kind === 'beat') beatScenes.add(sceneId)
    const reason = typeof entry.why === 'string' ? clip(entry.why, PLAN_LINKS_REASON_MAX) : ''
    out.push({ plan, sceneId, reason })
  }
  return out
}

/** Writes one link into the scene metadata; answers the node it rewrote. */
function applyLink(db: TreeDb, board: PlanBoard, link: PlanLinkSuggestion): string {
  if (link.plan.kind === 'scene') {
    const meta = board.metaOf.get(link.plan.nodeId) ?? parseStoredSceneMeta(null)
    const next = { ...meta, fulfilledBy: link.sceneId }
    setSceneMeta(db, link.plan.nodeId, next)
    board.metaOf.set(link.plan.nodeId, next)
    return link.plan.nodeId
  }
  const meta = board.metaOf.get(link.sceneId) ?? parseStoredSceneMeta(null)
  const next = { ...meta, beats: { ...meta.beats, [link.plan.template]: link.plan.beatId } }
  setSceneMeta(db, link.sceneId, next)
  board.metaOf.set(link.sceneId, next)
  return link.sceneId
}

/**
 * The plan-link job (F-11.1d): the gate (`planLinks`, Ask and up, its toggle), then one fast-tier
 * JSON request over the open plans and the summarized written scenes (none when either list is
 * empty), costed in the ledger. At chat mode Auto the links apply at once and are remembered as
 * AI-made; at Ask and Plan they are stored as suggestions, replacing earlier ones for the same
 * plans. Derived data like the summaries (CLAUDE.md, AI rule 1): never the manuscript's text,
 * removable with Unlink, and a dismissed or unlinked pair is never proposed again. The context
 * hash covers every line sent, so an unchanged project answers from the local cache.
 */
export async function runPlanLinks(
  db: TreeDb,
  deps: AiRequestDeps,
  input: { requestId?: string } = {}
): Promise<PlanLinksRunResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'planLinks')
  const state = getPlanLinkState(db)
  const dismissed = new Set(state.dismissed)
  const board = planBoard(db)
  const request = planLinkRequest(db, board, dismissed)
  if (request === null) {
    return { suggested: 0, applied: 0, changedNodeIds: [], requested: false, costUsd: 0 }
  }
  const prompt = buildPlanLinksPrompt({
    plans: request.plans.map((each) => each.line),
    scenes: request.scenes.map((each) => each.line)
  })
  const result = await runAiRequest(deps, {
    feature: 'planLinks',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify(prompt.messages)),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })
  const links = parsePlanLinksAnswer(result.text, request, dismissed)

  // Re-read: the request took a moment, and the author may have linked or written meanwhile.
  const now = planBoard(db)
  const fresh = links.filter((link) => stillValid(now, link))
  const auto = settings.chatMode === 'auto'
  const changed = new Set<string>()
  let next: PlanLinkState
  if (auto) {
    let aiApplied = state.aiApplied
    for (const link of fresh) {
      if (!stillValid(now, link)) continue
      changed.add(applyLink(db, now, link))
      aiApplied = withKey(aiApplied, planLinkKey(link), true)
    }
    const plans = new Set(fresh.map((link) => planKey(link.plan)))
    next = {
      ...state,
      aiApplied,
      suggestions: state.suggestions.filter((link) => !plans.has(planKey(link.plan)))
    }
  } else {
    const plans = new Set(fresh.map((link) => planKey(link.plan)))
    const kept = state.suggestions.filter(
      (link) => !plans.has(planKey(link.plan)) && stillValid(now, link)
    )
    next = { ...state, suggestions: [...fresh, ...kept].slice(0, PLAN_LINKS_SUGGESTIONS_MAX) }
  }
  setPlanLinkState(db, next)
  return {
    suggested: auto ? 0 : fresh.length,
    applied: auto ? changed.size : 0,
    changedNodeIds: [...changed],
    requested: true,
    costUsd: result.costUsd
  }
}

function suggestionByKey(state: PlanLinkState, key: string): PlanLinkSuggestion {
  const found = state.suggestions.find((link) => planLinkKey(link) === key)
  if (found === undefined) throw new AppError('NOT_FOUND', 'That suggestion is gone', { key })
  return found
}

/** The author confirms a suggestion: it applies, and leaves the list. Answers the rewritten node. */
export function confirmPlanLink(db: TreeDb, key: string): { changedNodeIds: string[] } {
  const state = getPlanLinkState(db)
  const link = suggestionByKey(state, key)
  const board = planBoard(db)
  if (!stillValid(board, link)) {
    setPlanLinkState(db, {
      ...state,
      suggestions: state.suggestions.filter((each) => each !== link)
    })
    throw new AppError('VALIDATION', 'That plan is already linked, or the scene changed', { key })
  }
  const changed = applyLink(db, board, link)
  setPlanLinkState(db, { ...state, suggestions: state.suggestions.filter((each) => each !== link) })
  return { changedNodeIds: [changed] }
}

/** The author dismisses a suggestion: it leaves the list and is never proposed again. */
export function dismissPlanLink(db: TreeDb, key: string): void {
  const state = getPlanLinkState(db)
  const link = suggestionByKey(state, key)
  setPlanLinkState(db, {
    ...state,
    suggestions: state.suggestions.filter((each) => each !== link),
    dismissed: withKey(state.dismissed, key, true)
  })
}

/**
 * The author unlinks a plan: a planned scene loses its `fulfilledBy`, a beat leaves the scene it
 * sits on. The pair is remembered as dismissed, so the job does not link it again. Answers the
 * node it rewrote (none when the plan was not linked).
 */
export function unlinkPlan(db: TreeDb, plan: PlanRef): { changedNodeIds: string[] } {
  const board = planBoard(db)
  let changed: string | null = null
  let sceneId: string | null = null
  if (plan.kind === 'scene') {
    const meta = board.metaOf.get(plan.nodeId)
    if (meta?.fulfilledBy !== undefined) {
      sceneId = meta.fulfilledBy
      const next: SceneMeta = { ...meta }
      delete next.fulfilledBy
      setSceneMeta(db, plan.nodeId, next)
      changed = plan.nodeId
    }
  } else {
    for (const [id, meta] of board.metaOf) {
      if (meta.beats[plan.template] !== plan.beatId) continue
      const beats = { ...meta.beats }
      delete beats[plan.template]
      setSceneMeta(db, id, { ...meta, beats })
      changed = id
      sceneId = id
      break
    }
  }
  if (sceneId !== null) {
    const key = planLinkKey({ plan, sceneId })
    const state = getPlanLinkState(db)
    setPlanLinkState(db, {
      ...state,
      dismissed: withKey(state.dismissed, key, true),
      aiApplied: withKey(state.aiApplied, key, false)
    })
  }
  return { changedNodeIds: changed === null ? [] : [changed] }
}
