import { z } from 'zod'
import type { AiFeatureId } from './ai'
import { PROPOSAL_NOTE_MAX } from './proposal'
import { QUICK_ACTION_IDS, type QuickActionId } from './quickActions'

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
  'notes'
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
  notes: 'Suggested notes'
}

/** The feature whose dial level and toggle gate each action (the router's own gate is `route`). */
export const ROUTE_ACTION_FEATURE: Record<RouteAction, AiFeatureId> = {
  chat: 'chat',
  query: 'query',
  rewrite: 'rewrite',
  critique: 'critique',
  betaReader: 'betaReader',
  proofread: 'proofread',
  continuity: 'continuity',
  whatNext: 'whatNext',
  synopsis: 'synopsis',
  notes: 'notesSuggest'
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

/** What the router decided, after the fallbacks. */
export interface RouteDecision {
  action: RouteAction
  /** The author's specific request restated for the action, or null when there is none. */
  instruction: string | null
}

/** What the open editor offers the chosen action: a document, and a selection in it. */
export interface RouteSituation {
  hasNode: boolean
  hasSelection: boolean
}

/**
 * The fallbacks every decision passes through, whether it came from the model or from the
 * short-circuit: `rewrite` needs a selection, and every scene action needs an open document;
 * otherwise the message goes to `chat`, which can always answer.
 */
export function settleRoute(decision: RouteDecision, situation: RouteSituation): RouteDecision {
  const { action } = decision
  if (action === 'rewrite' && !situation.hasSelection) return { action: 'chat', instruction: null }
  if (ROUTE_NODE_ACTIONS.includes(action) && !situation.hasNode) {
    return { action: 'chat', instruction: null }
  }
  return decision
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
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return { action: 'chat', instruction: null }
  const key = trimmed
    .replace(/[\s.!?]+$/u, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const action =
    ROUTE_ACTIONS.find((id) => id.toLowerCase() === key) ??
    QUICK_ACTION_IDS.flatMap((id) => (id.toLowerCase() === key ? [QUICK_ACTION_ROUTES[id]] : []))[0]
  return action === undefined ? null : settleRoute({ action, instruction: null }, situation)
}
