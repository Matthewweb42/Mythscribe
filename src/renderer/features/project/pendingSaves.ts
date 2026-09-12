/**
 * Pending-save registry (F-1.4). Anything holding unsaved edits registers a flusher here so
 * closing, opening, or quitting waits for it. F-3.2 autosave wires in with
 * `registerPendingSave(() => flush())` when the first document loads and unsubscribes on `clear()`.
 */
type Flush = () => Promise<void>

const flushers = new Set<Flush>()

/** Adds a flusher; the returned function removes it again. */
export function registerPendingSave(flush: Flush): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}

/**
 * Runs every registered flusher. All of them run even if one fails, so one broken document does
 * not stop the others from saving; the first failure is then rethrown so the caller learns of it.
 */
export async function flushPendingSaves(): Promise<void> {
  const results = await Promise.allSettled([...flushers].map((flush) => flush()))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

/** Clears the registry. For tests only. */
export function resetPendingSaves(): void {
  flushers.clear()
}
