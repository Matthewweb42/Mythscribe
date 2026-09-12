/**
 * The ghost-text trigger discipline (F-5.14; CLAUDE.md, token efficiency rule 5): a request
 * may leave only after a minimum idle interval, once enough new characters were typed since
 * the last request, while no proposal is pending or visible, and under the per-day request
 * cap. Pure so the editor (F-5.3) can ask on every idle tick without side effects; the USD cap
 * is a separate, app-wide guard in the request path.
 */
export interface ThrottleInput {
  /** Milliseconds since the last keystroke. */
  idleMs: number
  minIdleMs: number
  /** Characters typed since the last request left. */
  newChars: number
  minNewChars: number
  /** A request is on the wire. */
  pending: boolean
  /** A proposal is showing at the caret. */
  visible: boolean
  requestsToday: number
  dailyRequestCap: number
}

export function shouldTrigger(input: ThrottleInput): boolean {
  if (input.pending || input.visible) return false
  if (input.idleMs < input.minIdleMs) return false
  if (input.newChars < input.minNewChars) return false
  return input.requestsToday < input.dailyRequestCap
}
