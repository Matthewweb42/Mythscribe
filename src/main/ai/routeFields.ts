import {
  ROUTE_CHAPTER_MAX,
  ROUTE_INSTRUCTION_MAX,
  RouteAction,
  RouteEditPass,
  RouteEditTarget,
  type RouteDecision,
  type RouteEdit
} from '@shared/assistantRoute'

/**
 * route.v2's field readers (F-5.19, F-5.26), apart from the router's request path so a prompt
 * module can read the same fields (navigator.v1's first step, F-16.25) without importing the
 * request path, which imports the prompt catalogue.
 */

/** What an unreadable or unknown answer decides: the chat (the router never costs the turn). */
export const CHAT_DECISION: RouteDecision = { action: 'chat', instruction: null, edit: null }

/** route.v2's fields as a model wrote them: the router's answer, or navigator.v1's first step. */
export interface RouteFields {
  action: unknown
  instruction?: unknown
  pass?: unknown
  target?: unknown
  chapter?: unknown
}

/**
 * The decision `fields` name, leniently (F-5.19; F-16.25 reads navigator.v1's step 1 with it): an
 * action that is not a string or names no known action is `chat`; the instruction is trimmed and
 * cut to `ROUTE_INSTRUCTION_MAX`, and blank or not a string is null. The action is matched
 * case-insensitively, since models capitalise ids now and then. An `editPass` decision (route.v2,
 * F-5.26) also carries its pass (unknown reads as `ask`), its target (unknown reads as `scene`),
 * and the chapter it names (blank is null); `settleRoute` then completes and checks it.
 */
export function readRouteFields(fields: RouteFields): RouteDecision {
  if (typeof fields.action !== 'string') return CHAT_DECISION
  const action = matchId(RouteAction.options, fields.action)
  if (action === undefined) return CHAT_DECISION
  const instruction = cleanText(fields.instruction, ROUTE_INSTRUCTION_MAX)
  if (action !== 'editPass') return { action, instruction, edit: null }
  const edit: RouteEdit = {
    pass: matchId(RouteEditPass.options, fields.pass) ?? 'ask',
    target: matchId(RouteEditTarget.options, fields.target) ?? 'scene',
    chapter: cleanText(fields.chapter, ROUTE_CHAPTER_MAX)
  }
  return { action, instruction, edit }
}

/** The id in `ids` that `value` names, ignoring case and surrounding space; undefined for none. */
export function matchId<T extends string>(ids: readonly T[], value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined
  const wanted = value.trim().toLowerCase()
  return ids.find((id) => id.toLowerCase() === wanted)
}

/** A string trimmed and cut to `max`; blank or not a string is null. */
export function cleanText(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim().slice(0, max).trim() : ''
  return text || null
}
