/** New characters the author must type between two ghost-text requests (F-5.3). */
export const GHOST_MIN_NEW_CHARS = 12
/**
 * The soft per-day request cap for ghost text (F-5.3), counted in the renderer for the session
 * (not persisted; a restart loosens it at most). The persisted, app-wide USD cap in the request
 * path (F-5.14) is the real backstop.
 */
export const GHOST_MAX_PER_DAY = 200
/** No ghost-text request leaves for this long after one fails (rate limit, network, provider). */
export const GHOST_BACKOFF_MS = 30_000

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
