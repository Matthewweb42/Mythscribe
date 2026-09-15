import { aiFailure } from '@shared/ai'
import type { SummaryStatus } from '@shared/summary'
import { AppError } from '../ipc/errors'
import { AiCancelledError, AiDisabledError, AiProviderError } from './providers/types'

/**
 * The background summary scheduler (F-5.6): the minimal per-node debounce that keeps scene
 * summaries fresh without ever blocking typing (CLAUDE.md, token rule 7). Every
 * `document:save` touches the node; the run happens `delayMs` after the last touch, one node
 * at a time, so a burst of saves costs one request. F-5.13's job queue grows out of this
 * (resumable, rate-limited, batched); until then it is a map of timers and a serial chain.
 *
 * Nothing here throws into the background: a failed run is recorded as the node's status and
 * last error, which `summary:get` and the `ai:summaryChanged` event carry to the pane where
 * the author can act on it. `runNow` is the foreground path (`ai:summarize`) and does reject,
 * so the channel can answer the exact failure code the renderer expects.
 *
 * A node counts as `pending` from the moment it is touched, not from the moment its run
 * starts: the pane says "Updating…" through the debounce as well as the request.
 */

/** What the scheduler records for a node whose last run failed; the shape `summary:get` carries. */
export interface SummaryFailure {
  message: string
  nextStep: string
}

export interface SummarySchedulerOptions<T> {
  /** Milliseconds of quiet after the last touch before the node is summarised. */
  delayMs: number
  /** The run itself; `requestId` is set only on the foreground path, for `ai:cancel`. */
  run: (nodeId: string, requestId?: string) => Promise<T>
  /** Called whenever a node's status changes, never when it stays the same. */
  onStatus?: (nodeId: string, status: SummaryStatus) => void
}

export interface SummaryScheduler<T> {
  /** The node changed: (re)start its debounce and mark it pending. */
  touch(nodeId: string): void
  /**
   * Summarise the node now: its debounce is cancelled, the run is awaited, and its result
   * comes back. A run already in flight for the node is joined rather than doubled. Rejects
   * with whatever the run threw, after recording the node's status.
   */
  runNow(nodeId: string, requestId?: string): Promise<T>
  /** Forget every timer, status, and queued run (a project closed or another one opened). */
  clear(): void
  statusOf(nodeId: string): SummaryStatus
  errorOf(nodeId: string): SummaryFailure | null
}

/** The failures that are not the author's problem: the run simply did not happen. */
function isQuiet(err: unknown): boolean {
  if (err instanceof AiDisabledError || err instanceof AiCancelledError) return true
  // A scene below the gate, or one that left the manuscript while the timer ran: there is
  // nothing to summarise and nothing to act on, so the node goes quiet instead of red.
  return err instanceof AppError && (err.code === 'VALIDATION' || err.code === 'NOT_FOUND')
}

function failureOf(err: unknown): SummaryFailure {
  const { message, nextStep } =
    err instanceof AiProviderError
      ? aiFailure(err.code, err.message)
      : aiFailure('PROVIDER', err instanceof Error ? err.message : String(err))
  return { message, nextStep }
}

export function createSummaryScheduler<T>({
  delayMs,
  run,
  onStatus
}: SummarySchedulerOptions<T>): SummaryScheduler<T> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const statuses = new Map<string, SummaryStatus>()
  const errors = new Map<string, SummaryFailure>()
  /** The runs waiting for their turn, one per node; a node's entry goes as its run starts. */
  const queued = new Map<string, Promise<T>>()
  /**
   * The foreground request id a node's next run must carry, read as the run starts: a
   * `runNow` that joins a run still queued behind another node's would otherwise leave its
   * id behind and `ai:cancel` would find nothing.
   */
  const requestIds = new Map<string, string>()
  /** The run in flight, so `runNow` joins it instead of asking for the same summary twice. */
  let active: { nodeId: string; promise: Promise<T> } | null = null
  /** The serial chain: one run at a time, and it never rejects. */
  let chain: Promise<unknown> = Promise.resolve()
  /** Bumped by `clear()`; a run from an older generation writes nothing. */
  let generation = 0

  const setStatus = (nodeId: string, status: SummaryStatus, error: SummaryFailure | null): void => {
    const previous = statuses.get(nodeId) ?? 'idle'
    if (status === 'idle') statuses.delete(nodeId)
    else statuses.set(nodeId, status)
    if (error === null) errors.delete(nodeId)
    else errors.set(nodeId, error)
    if (previous !== status) onStatus?.(nodeId, status)
  }

  const cancelTimer = (nodeId: string): void => {
    const timer = timers.get(nodeId)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(nodeId)
  }

  async function execute(nodeId: string, at: number, requestId?: string): Promise<T> {
    try {
      const result = await run(nodeId, requestId)
      if (at === generation) setStatus(nodeId, 'idle', null)
      return result
    } catch (err) {
      if (at === generation) {
        if (isQuiet(err)) setStatus(nodeId, 'idle', null)
        else setStatus(nodeId, 'failed', failureOf(err))
      }
      throw err
    }
  }

  function schedule(nodeId: string, options: { join: boolean }): Promise<T> {
    if (options.join && active !== null && active.nodeId === nodeId) {
      // Joined in flight: the run already carries whatever id it started with.
      requestIds.delete(nodeId)
      return active.promise
    }
    const waiting = queued.get(nodeId)
    if (waiting !== undefined) return waiting

    const at = generation
    const promise = chain.then(() => {
      // From here a touch queues a fresh run instead of joining this one, which is how a save
      // during a run re-queues the node exactly once.
      queued.delete(nodeId)
      if (at !== generation) throw new AppError('VALIDATION', 'The project changed', { nodeId })
      const requestId = requestIds.get(nodeId)
      requestIds.delete(nodeId)
      const running = execute(nodeId, at, requestId)
      active = { nodeId, promise: running }
      return running.finally(() => {
        if (active?.promise === running) active = null
      })
    })
    queued.set(nodeId, promise)
    chain = promise.catch(() => undefined)
    return promise
  }

  return {
    touch(nodeId) {
      cancelTimer(nodeId)
      setStatus(nodeId, 'pending', null)
      const timer = setTimeout(() => {
        timers.delete(nodeId)
        // The background path swallows: an unhandled rejection must never come from a save.
        void schedule(nodeId, { join: false }).catch(() => undefined)
      }, delayMs)
      // Never hold the process open for a summary: quitting mid-debounce just drops it.
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
      timers.set(nodeId, timer)
    },

    runNow(nodeId, requestId) {
      cancelTimer(nodeId)
      setStatus(nodeId, 'pending', null)
      if (requestId === undefined) requestIds.delete(nodeId)
      else requestIds.set(nodeId, requestId)
      return schedule(nodeId, { join: true })
    },

    clear() {
      generation += 1
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      queued.clear()
      requestIds.clear()
      statuses.clear()
      errors.clear()
      active = null
    },

    statusOf: (nodeId) => statuses.get(nodeId) ?? 'idle',
    errorOf: (nodeId) => errors.get(nodeId) ?? null
  }
}
