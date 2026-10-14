import { z } from 'zod'
import type { AiFeatureId } from './ai'
import { EDIT_PASS_TYPES } from './editPass'
import { PROPOSAL_NOTE_MAX } from './proposal'
import { QUICK_ACTION_IDS, type QuickActionId } from './quickActions'
import type { StoryMemoryVersion } from './storyMemory'

/**
 * The assistant router (F-5.19): one fast-tier JSON call that reads the author's chat message
 * and picks the feature that answers it, so every AI action can be asked for in the chat
 * instead of through its own button. The provider layer and the Cloud Worker have no native
 * tool calling (a fixed request body), so routing is a classification call and the chosen
 * feature then runs its own pipeline (fidelity checks, proposals, ledger) unchanged. Decided by
 * Claude, unconfirmed (2026-10-06). This file owns the action list, the caps on what the router
 * reads, and the local short-circuit that needs no request at all.
 */

/**
 * What the router can answer. `query` is a question about the facts of the book (ai:query,
 * cited); `chat` is everything else, discussion and brainstorming (ai:chat). The rest name the
 * existing scene features; `synopsis` and `notes` are the side-panel suggestions (F-5.20).
 * `editPass` (F-5.26, route.v2, requested by the author 2026-10-11) is a request to improve,
 * polish, tighten, or fix a passage, a scene, or a chapter: it runs an edit pass (F-14.15) whose
 * changes come back as tracked changes, or first asks which kind of edit (`RouteEdit`).
 */
export const ROUTE_ACTIONS = [
  'chat',
  'query',
  'rewrite',
  'critique',
  'betaReader',
  'proofread',
  'continuity',
  'whatNext',
  'synopsis',
  'notes',
  'editPass'
] as const
export const RouteAction = z.enum(ROUTE_ACTIONS)
export type RouteAction = z.infer<typeof RouteAction>

/** The label a routed turn carries in the chat, naming what answered it. */
export const ROUTE_ACTION_LABEL: Record<RouteAction, string> = {
  chat: 'Chat',
  query: 'Story question',
  rewrite: 'Rewrite',
  critique: "Editor's notes",
  betaReader: 'Beta reader',
  proofread: 'Proofread',
  continuity: 'Check consistency',
  whatNext: 'What should come next?',
  synopsis: 'Suggested synopsis',
  notes: 'Suggested notes',
  editPass: 'Edit pass'
}

/**
 * The feature whose dial level and toggle gate each action in a v1 project (the router's own gate
 * is `route`); read through `routeActionFeature`, which knows v2's.
 */
const ROUTE_ACTION_FEATURE: Record<RouteAction, AiFeatureId> = {
  chat: 'chat',
  query: 'query',
  rewrite: 'rewrite',
  critique: 'critique',
  betaReader: 'betaReader',
  proofread: 'proofread',
  continuity: 'continuity',
  whatNext: 'whatNext',
  synopsis: 'synopsis',
  notes: 'notesSuggest',
  editPass: 'editPass'
}

/**
 * The feature that gates `action` in a project with story memory `memory` (F-16.25, P3-D17): in
 * v2 a chat message or a question about the book is Ms Scribe's (`agent`, behind the navigator),
 * since v2 hides `chat`'s router and Story Intelligence; the consistency check is the
 * Contradiction check's (`judge`, P4-D23: v2 answers it from the open scene's findings, with no
 * request; v1 keeps `continuity.v2`); every other action keeps its feature.
 */
export function routeActionFeature(action: RouteAction, memory: StoryMemoryVersion): AiFeatureId {
  if (memory === 'v2' && (action === 'chat' || action === 'query')) return 'agent'
  if (memory === 'v2' && action === 'continuity') return 'judge'
  return ROUTE_ACTION_FEATURE[action]
}

/** The actions that act on the open document; without one they fall back to `chat`. */
export const ROUTE_NODE_ACTIONS: readonly RouteAction[] = [
  'rewrite',
  'critique',
  'betaReader',
  'proofread',
  'continuity',
  'whatNext',
  'synopsis',
  'notes'
]

/** How much of the message the router reads: the request is in its opening, not its tail. */
export const ROUTE_MESSAGE_CHARS = 1_000
/** How many recent turns ride along (a follow-up such as "do it again" needs the last exchange). */
export const ROUTE_HISTORY_TURNS = 2
/** Each of those turns is cut to this many characters. */
export const ROUTE_TURN_CHARS = 300
/** The opening of the selected passage the router sees, so it can tell a rewrite from a question about it. */
export const ROUTE_SELECTION_PREVIEW_CHARS = 200
/** The open document's title as the router sees it. */
export const ROUTE_TITLE_CHARS = 100
/**
 * The instruction the router restates for the chosen feature (a rewrite's note, a notes
 * focus); capped at the proposal note's length so it can ride on a rewrite unchanged.
 */
export const ROUTE_INSTRUCTION_MAX = PROPOSAL_NOTE_MAX

/**
 * The pass an `editPass` decision names (F-5.26): `ask` when the request is vague ("make this
 * better"), so the chat asks which kind of edit first; an edit pass type; or `dialogue`, a custom
 * pass with the built-in dialogue instruction.
 */
export const ROUTE_EDIT_PASSES = ['ask', ...EDIT_PASS_TYPES, 'dialogue'] as const
export const RouteEditPass = z.enum(ROUTE_EDIT_PASSES)
export type RouteEditPass = z.infer<typeof RouteEditPass>

/** What an `editPass` decision covers: the selected passage, the open scene, or a chapter. */
export const ROUTE_EDIT_TARGETS = ['selection', 'scene', 'chapter'] as const
export const RouteEditTarget = z.enum(ROUTE_EDIT_TARGETS)
export type RouteEditTarget = z.infer<typeof RouteEditTarget>

/** The chapter the author named ("chapter 3", "The Crossing"), as the router restates it. */
export const ROUTE_CHAPTER_MAX = 100

export const RouteEdit = z.object({
  pass: RouteEditPass,
  target: RouteEditTarget,
  /** The chapter the author named, or null for the open scene's chapter (and other targets). */
  chapter: z.string().max(ROUTE_CHAPTER_MAX).nullable()
})
export type RouteEdit = z.infer<typeof RouteEdit>

/** What the router decided, after the fallbacks. */
export interface RouteDecision {
  action: RouteAction
  /** The author's specific request restated for the action, or null when there is none. */
  instruction: string | null
  /** An `editPass` decision's pass and target (F-5.26); null for every other action. */
  edit: RouteEdit | null
}

/** What the open editor offers the chosen action: a document, and a selection in it. */
export interface RouteSituation {
  hasNode: boolean
  hasSelection: boolean
}

const CHAT: RouteDecision = { action: 'chat', instruction: null, edit: null }

/**
 * The fallbacks every decision passes through, whether it came from the model or from the
 * short-circuit: every scene action needs an open document; otherwise the message goes to
 * `chat`, which can always answer. F-5.26 (route.v2): a `rewrite` without a selection is an
 * edit pass on the open scene (a custom pass carrying the request, or the question which edit
 * when there is none) instead of chat. An `editPass` decision is completed and checked: missing
 * fields ask on the selection (or the scene); a selection target without a selection is the
 * scene; a custom pass with no instruction asks; it needs an open document unless it names a
 * chapter. Every other decision carries no `edit`.
 */
export function settleRoute(decision: RouteDecision, situation: RouteSituation): RouteDecision {
  const { action, instruction } = decision
  if (action === 'rewrite' && !situation.hasSelection) {
    if (!situation.hasNode) return CHAT
    return {
      action: 'editPass',
      instruction,
      edit: { pass: instruction === null ? 'ask' : 'custom', target: 'scene', chapter: null }
    }
  }
  if (action === 'editPass') {
    const edit = decision.edit ?? {
      pass: 'ask',
      target: situation.hasSelection ? 'selection' : 'scene',
      chapter: null
    }
    const target = edit.target === 'selection' && !situation.hasSelection ? 'scene' : edit.target
    const chapter = target === 'chapter' ? edit.chapter : null
    if (!situation.hasNode && chapter === null) return CHAT
    const pass = edit.pass === 'custom' && instruction === null ? 'ask' : edit.pass
    return { action, instruction, edit: { pass, target, chapter } }
  }
  if (ROUTE_NODE_ACTIONS.includes(action) && !situation.hasNode) return CHAT
  return decision.edit === null ? decision : { ...decision, edit: null }
}

/** The quick-action ids (F-5.17) as router actions; the recap is a Story Intelligence question. */
const QUICK_ACTION_ROUTES: Record<QuickActionId, RouteAction> = {
  whatNext: 'whatNext',
  proofread: 'proofread',
  continuity: 'continuity',
  recap: 'query'
}

/**
 * The decision that needs no request (F-5.19): a message with no letter or digit in it goes to
 * `chat`, and a message that is exactly an action id or a quick-action id (any case, trailing
 * punctuation ignored, e.g. "Proofread" or "whatNext?") is that action. Null when the model has
 * to decide. The result still passes `settleRoute`.
 */
export function localRoute(message: string, situation: RouteSituation): RouteDecision | null {
  const trimmed = message.trim()
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return CHAT
  const key = trimmed
    .replace(/[\s.!?]+$/u, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const action =
    ROUTE_ACTIONS.find((id) => id.toLowerCase() === key) ??
    QUICK_ACTION_IDS.flatMap((id) => (id.toLowerCase() === key ? [QUICK_ACTION_ROUTES[id]] : []))[0]
  return action === undefined
    ? null
    : settleRoute({ action, instruction: null, edit: null }, situation)
}

/**
 * P4-D23 (story memory v2, decided by Claude in P4 slice 4, unconfirmed): the consistency check's
 * own words, as the chat's suggestion and the turn's label give them, any case and trailing
 * punctuation ignored. In v2 the check is answered locally from the open scene's findings, so a
 * request to the navigator only to reach a free answer would cost for nothing.
 */
export const CONTINUITY_PHRASES: readonly string[] = [
  'Check this scene for consistency',
  'Check this scene for continuity slips',
  ROUTE_ACTION_LABEL.continuity
]

const phraseKey = (text: string): string =>
  text
    .trim()
    .replace(/[\s.!?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()

/**
 * The navigator's request-free decision (F-16.25, story memory v2): `localRoute`'s, then one of
 * `CONTINUITY_PHRASES` is the consistency check. v1's router keeps `localRoute` alone.
 */
export function memoryLocalRoute(message: string, situation: RouteSituation): RouteDecision | null {
  const local = localRoute(message, situation)
  if (local !== null) return local
  const key = phraseKey(message)
  return CONTINUITY_PHRASES.some((phrase) => phraseKey(phrase) === key)
    ? settleRoute({ action: 'continuity', instruction: null, edit: null }, situation)
    : null
}
