import { AppError } from '../ipc/errors'

/**
 * The one registry of AI requests in flight (F-5.10), keyed by the `requestId` the caller
 * minted. The request path registers on entry and releases in `finally`; `ai:cancel` aborts
 * by id. Process-wide, not per project: a request outlives nothing but its own promise, and
 * the renderer that minted the id is the only one that knows it.
 */
const inflight = new Map<string, AbortController>()

/** The suffix a use case's fidelity regenerate (F-14.7) registers under, so a cancel during the second call lands too. */
export function regenRequestId(requestId: string): string {
  return `${requestId}:regen`
}

/** Registers a request; a duplicate id is VALIDATION (an id is used once, never reused while pending). */
export function registerInflight(requestId: string): AbortController {
  if (inflight.has(requestId)) {
    throw new AppError('VALIDATION', 'An AI request with this id is already in flight', {
      requestId
    })
  }
  const controller = new AbortController()
  inflight.set(requestId, controller)
  return controller
}

/** Aborts the request; false when nothing by that id is in flight (finished, or never started). */
export function cancelInflight(requestId: string): boolean {
  const controller = inflight.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Forgets the request; the owner calls it once the request settled, whatever the outcome. */
export function releaseInflight(requestId: string): void {
  inflight.delete(requestId)
}

export function inflightCount(): number {
  return inflight.size
}

/** For tests: the registry is module state. */
export function resetInflight(): void {
  inflight.clear()
}
