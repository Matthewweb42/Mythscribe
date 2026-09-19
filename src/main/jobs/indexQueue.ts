import { aiFailure, type AiErrorCode } from '@shared/ai'
import {
  IDLE_INDEX_QUEUE,
  JOB_BACKOFF_MS,
  JOB_MAX_ATTEMPTS,
  JOB_MIN_INTERVAL_MS,
  type IndexQueueStatus,
  type JobFailure,
  type JobKind
} from '@shared/jobs'
import type { SummaryStatus } from '@shared/summary'
import { AiCancelledError, AiDisabledError, AiProviderError } from '../ai/providers/types'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'
import {
  bumpAttempts,
  deleteAllJobs,
  deleteJob,
  enqueueJob,
  getJob,
  jobId,
  listJobs,
  markFailed,
  requeueFailed,
  type IndexJob
} from './jobStore'

/**
 * The background index queue (F-5.13), grown out of the F-5.6 summary scheduler: one queue for
 * the session, bound to the open project through the `db` accessor at run time (never a captured
 * handle), one job at a time, at most one provider request per `minIntervalMs`, and every job
 * that is waiting or gave up in `index_job`, so quitting mid-queue loses nothing.
 *
 * What lives where: the rows are the truth about what is left to do; what is running, the
 * debounce windows, the backoff deadlines, and the pause are memory, so a crash leaves a
 * running job `queued` and reopening the project resumes it (`load`).
 *
 * How a failure is treated (CLAUDE.md, errors are handled where the author can act):
 * - transient (rate limit, network, a provider that answered nonsense): the same job again after
 *   `backoffMs`, and after `maxAttempts` the row goes `failed` with the message and the next
 *   step, where the indicator's Retry can reach it;
 * - hard (no key, bad key, quota, over budget, the feature turned off): the whole queue pauses
 *   with that reason and the job stays queued — hammering a missing key is pointless. Reopening
 *   the project, Retry, or a Summarize now that works clears the pause;
 * - quiet (the scene is under the floor or left the manuscript): the row goes, the node goes
 *   idle, and nothing is shown — there was never anything to do;
 * - cancelled: the row was already deleted by `cancelAll`; nothing is recorded.
 *
 * The one exception is the author's own Summarize now against a turned-off feature: the channel
 * answers that as data, so the node goes quiet instead of red and the queue keeps its place.
 *
 * Nothing here throws into a timer: the background path swallows, and only `runNow` (the
 * author's Summarize now) rejects, so `ai:summarize` can answer the exact failure.
 */

/** A job as the queue hands it to the runner. */
export interface QueuedJob {
  kind: JobKind
  nodeId: string
}

/** What a run answers: its result, and whether a provider request actually left. */
export interface JobRun<T> {
  /**
   * False for a run that made no request (a stored row whose content hash still matches, a
   * local cache hit), so the rate limit only counts real requests.
   */
  requested: boolean
  value: T
}

export interface IndexQueueOptions<T> {
  /** The open project's database, or null when none is open; read at run time, never captured. */
  db: () => TreeDb | null
  /** Runs one job. `requestId` is registered in flight, so the run can be aborted. */
  run: (job: QueuedJob, requestId: string) => Promise<JobRun<T>>
  /** Aborts the request in flight under that id (the inflight registry, F-5.10). */
  cancelRequest: (requestId: string) => void
  now?: () => Date
  /** The queue changed: something was queued, started, finished, failed, or it paused. */
  onChange?: (status: IndexQueueStatus) => void
  /** A node's status changed, never when it stays the same (the summary pane's "Updating…"). */
  onNodeStatus?: (nodeId: string, status: SummaryStatus) => void
  /** Milliseconds of quiet after the last `touch` of a node before its job is queued. */
  debounceMs: number
  minIntervalMs?: number
  backoffMs?: readonly number[]
  maxAttempts?: number
  /** The id a background job's request carries; `job-<n>` in the app. */
  requestIdFor?: (n: number) => string
}

export interface IndexQueue<T> {
  /** The node changed: (re)start its debounce; the node counts as pending at once. */
  touch(kind: JobKind, nodeId: string): void
  /**
   * Run this node's job now, ahead of the queue (the author asked). A run already in flight or
   * waiting its turn for the node is joined instead of doubled, and carries the author's
   * request id so it can be stopped; otherwise the run happens as soon as the job in flight is
   * done, and its queued row goes with it. Rejects with whatever the run threw, after recording
   * the node's status.
   */
  runNow(kind: JobKind, nodeId: string, requestId: string): Promise<T>
  /** A project opened: take up the jobs it left behind and start working. */
  load(): void
  /** Queues one job per node, skipping the ones already queued; answers how many were new. */
  indexAll(kind: JobKind, nodeIds: string[]): number
  /** Stop: abort what is running, drop every job and debounce, clear the pause. */
  cancelAll(): IndexQueueStatus
  /** Try again: clear the pause, put the failed jobs back in the queue, start working. */
  resume(): IndexQueueStatus
  /** The project closed: drop every timer and everything remembered; the rows stay. */
  clear(): void
  status(): IndexQueueStatus
  /** What the summary pane shows for a node: queued, running, or debouncing is `pending`. */
  nodeStatus(nodeId: string): SummaryStatus
  nodeError(nodeId: string): JobFailure | null
}

/** The failures that pause the queue instead of retrying: nothing will change without the author. */
const HARD_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'NO_KEY',
  'INVALID_KEY',
  'QUOTA',
  'BUDGET',
  'DISABLED',
  // F-15.4: neither a signed-out account nor an empty balance improves by retrying.
  'SIGNED_OUT',
  'NO_CREDIT'
])

type Outcome = 'quiet' | 'cancelled' | 'transient' | 'hard'

/** What went wrong, from the queue's point of view. */
function classify(err: unknown): Outcome {
  if (err instanceof AiCancelledError) return 'cancelled'
  // A scene below the gate, or one that left the manuscript while the job waited: there is
  // nothing to summarise and nothing the author could act on.
  if (err instanceof AppError && (err.code === 'VALIDATION' || err.code === 'NOT_FOUND')) {
    return 'quiet'
  }
  if (err instanceof AiDisabledError) return 'hard'
  if (err instanceof AiProviderError) return HARD_CODES.has(err.code) ? 'hard' : 'transient'
  return 'transient'
}

function failureOf(err: unknown): JobFailure {
  const { code, message, nextStep } =
    err instanceof AiProviderError
      ? aiFailure(err.code, err.message)
      : aiFailure('PROVIDER', err instanceof Error ? err.message : String(err))
  return { code, message, nextStep }
}

/** Never hold the process open for an index job: quitting mid-queue just drops the timer. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  return timer
}

export function createIndexQueue<T>(options: IndexQueueOptions<T>): IndexQueue<T> {
  const {
    db: database,
    run,
    cancelRequest,
    now = () => new Date(),
    onChange,
    onNodeStatus,
    debounceMs,
    minIntervalMs = JOB_MIN_INTERVAL_MS,
    backoffMs = JOB_BACKOFF_MS,
    maxAttempts = JOB_MAX_ATTEMPTS,
    requestIdFor = (n) => `job-${n}`
  } = options

  /** The debounce windows, by job id; a save restarts its node's. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** What each node shows, so the pane's "Updating…" never needs a query. */
  const statuses = new Map<string, SummaryStatus>()
  const errors = new Map<string, JobFailure>()
  /** The run in flight or waiting its turn, per job id, so `runNow` joins it instead of asking twice. */
  const active = new Map<string, Promise<T>>()
  /**
   * The request id a job's next run must carry: a `runNow` that joined a background run still
   * waiting its turn would otherwise leave its id behind and `ai:cancel` would find nothing.
   */
  const foregroundIds = new Map<string, string>()
  /** Earliest moment a job may be tried again after a transient failure (memory only). */
  const retryAt = new Map<string, number>()
  /**
   * Jobs whose node was saved again while the job was running: their row stays queued when the
   * run finishes, so a save mid-run is summarised once more and exactly once.
   */
  const dirty = new Set<string>()
  let running: { id: string; job: QueuedJob; requestId: string } | null = null
  let paused: JobFailure | null = null
  let done = 0
  /** Bumped by `clear()`; a run from an older generation writes nothing. */
  let generation = 0
  let counter = 0
  /** When the last real provider request started, for the rate limit. */
  let lastRequestAt: number | null = null
  let pumping = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** The serial lane: one job at a time, foreground and background alike. */
  let chain: Promise<unknown> = Promise.resolve()

  const serial = <R>(task: () => Promise<R>): Promise<R> => {
    const result = chain.then(task)
    chain = result.catch(() => undefined)
    return result
  }

  const announce = (nodeId: string, status: SummaryStatus, error: JobFailure | null): void => {
    const previous = statuses.get(nodeId) ?? 'idle'
    if (status === 'idle') statuses.delete(nodeId)
    else statuses.set(nodeId, status)
    if (error === null) errors.delete(nodeId)
    else errors.set(nodeId, error)
    if (previous !== status) onNodeStatus?.(nodeId, status)
  }

  const cancelTimer = (id: string): void => {
    const timer = timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(id)
  }

  /**
   * Queues a node's job and answers whether there is now work that was not already waiting.
   * A node saved while its own job is running must run once more when that run ends, whether
   * the run had a row (background: one row per kind and node, so it cannot be queued twice) or
   * not (the author's Summarize now: the save inserts the row, and the run's success must not
   * delete it). `afterRunning` marks it dirty for that, and the row is kept when the run ends.
   * "Summarize all scenes" does not ask for that: the run already in flight is the summary it
   * wanted.
   */
  function queueJob(db: TreeDb, kind: JobKind, nodeId: string, afterRunning: boolean): boolean {
    const id = jobId(kind, nodeId)
    const inserted = enqueueJob(db, kind, nodeId, now())
    if (afterRunning && running?.id === id) {
      dirty.add(id)
      return true
    }
    return inserted
  }

  function currentStatus(): IndexQueueStatus {
    const db = database()
    if (db === null) return IDLE_INDEX_QUEUE
    const jobs = listJobs(db)
    const queued = jobs.filter((job) => job.status === 'queued' && job.id !== running?.id).length
    const failed = jobs.filter((job) => job.status === 'failed').length
    // Idle again: the "3 of 12" counter starts over with the next burst.
    if (queued === 0 && failed === 0 && running === null && paused === null) done = 0
    return { queued, running: running === null ? null : { ...running.job }, failed, done, paused }
  }

  const emit = (): void => onChange?.(currentStatus())

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => unref(setTimeout(resolve, ms)))

  /** The oldest queued job that is not waiting out a backoff. */
  function pickNext(db: TreeDb): IndexJob | null {
    const at = now().getTime()
    return (
      listJobs(db).find((job) => job.status === 'queued' && (retryAt.get(job.id) ?? 0) <= at) ??
      null
    )
  }

  /** Comes back to the queue when the earliest backoff is over. */
  function armRetry(db: TreeDb): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    const at = now().getTime()
    const waiting = listJobs(db)
      .filter((job) => job.status === 'queued')
      .map((job) => retryAt.get(job.id) ?? 0)
      .filter((deadline) => deadline > at)
    if (waiting.length === 0) return
    retryTimer = unref(
      setTimeout(
        () => {
          retryTimer = null
          kick()
        },
        Math.max(0, Math.min(...waiting) - at)
      )
    )
  }

  function kick(): void {
    if (pumping || paused !== null) return
    pumping = true
    const at = generation
    void pump(at).finally(() => {
      pumping = false
    })
  }

  async function pump(at: number): Promise<void> {
    for (;;) {
      if (at !== generation || paused !== null) return
      const db = database()
      if (db === null) return
      const next = pickNext(db)
      if (next === null) {
        armRetry(db)
        return
      }
      const promise = track(
        next.id,
        serial(() => runBackground(next, at))
      )
      // The background path swallows: an unhandled rejection must never come from a save.
      await promise.catch(() => undefined)
    }
  }

  /** Holds a run so `runNow` can join it, and forgets it however it ends. */
  function track(id: string, promise: Promise<T>): Promise<T> {
    active.set(id, promise)
    void promise.then(
      () => {
        if (active.get(id) === promise) active.delete(id)
      },
      () => {
        if (active.get(id) === promise) active.delete(id)
      }
    )
    return promise
  }

  /** Waits until the rate limit allows another request to start. */
  async function waitForSlot(): Promise<void> {
    if (lastRequestAt === null) return
    const wait = lastRequestAt + minIntervalMs - now().getTime()
    if (wait > 0) await delay(wait)
  }

  /**
   * One background job. Its preconditions (the project changed, the queue paused, the row is
   * gone) reject without recording anything; only the run itself is recorded.
   */
  async function runBackground(job: IndexJob, at: number): Promise<T> {
    const gone = (reason: string): AppError =>
      new AppError('NOT_FOUND', reason, { job: job.id, nodeId: job.nodeId })
    if (at !== generation || paused !== null) throw gone('The job is no longer due')
    await waitForSlot()
    if (at !== generation || paused !== null) throw gone('The job is no longer due')
    const db = database()
    if (db === null) throw gone('No project is open')
    // The row may have gone while the job waited: cancelled, or its node was deleted.
    const fresh = getJob(db, job.id)
    if (fresh?.status !== 'queued') throw gone('The job is gone')

    counter += 1
    const requestId = foregroundIds.get(fresh.id) ?? requestIdFor(counter)
    foregroundIds.delete(fresh.id)
    const target: QueuedJob = { kind: fresh.kind, nodeId: fresh.nodeId }
    running = { id: fresh.id, job: target, requestId }
    announce(fresh.nodeId, 'pending', null)
    emit()
    const startedAt = now().getTime()
    try {
      const outcome = await run(target, requestId)
      if (outcome.requested) lastRequestAt = startedAt
      if (at === generation) {
        retryAt.delete(fresh.id)
        done += 1
        if (dirty.delete(fresh.id)) {
          // The scene was saved again while this job ran: its row waits for one more run.
          announce(fresh.nodeId, 'pending', null)
        } else {
          deleteJob(db, fresh.id)
          announce(fresh.nodeId, 'idle', null)
        }
      }
      return outcome.value
    } catch (err) {
      const outcome = classify(err)
      if (outcome !== 'quiet') lastRequestAt = startedAt
      if (at === generation) recordFailure(db, fresh, outcome, err)
      throw err
    } finally {
      if (running?.id === fresh.id) running = null
      if (at === generation) emit()
    }
  }

  /** What a failed background run leaves behind: a retry, a `failed` row, a pause, or nothing. */
  function recordFailure(db: TreeDb, job: IndexJob, outcome: Outcome, err: unknown): void {
    dirty.delete(job.id)
    if (outcome === 'quiet' || outcome === 'cancelled') {
      // Quiet: there was nothing to do. Cancelled: `cancelAll` already emptied the table.
      if (outcome === 'quiet') deleteJob(db, job.id)
      retryAt.delete(job.id)
      announce(job.nodeId, 'idle', null)
      return
    }
    const failure = failureOf(err)
    if (outcome === 'hard') {
      // The job keeps its place and its attempts: nothing will change until the author acts.
      paused = failure
      return
    }
    const attempts = job.attempts + 1
    if (attempts >= maxAttempts) {
      markFailed(db, job.id, attempts, failure, now())
      retryAt.delete(job.id)
      announce(job.nodeId, 'failed', failure)
      return
    }
    bumpAttempts(db, job.id, attempts, now())
    const backoff = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 0
    retryAt.set(job.id, now().getTime() + backoff)
    announce(job.nodeId, 'pending', null)
  }

  /** The author's Summarize now: ahead of the queue, and it rejects with the real error. */
  async function runForeground(
    job: QueuedJob,
    id: string,
    requestId: string,
    at: number
  ): Promise<T> {
    if (at !== generation) {
      throw new AppError('VALIDATION', 'The project changed', { nodeId: job.nodeId })
    }
    running = { id, job, requestId }
    announce(job.nodeId, 'pending', null)
    emit()
    const startedAt = now().getTime()
    try {
      const outcome = await run(job, requestId)
      if (outcome.requested) lastRequestAt = startedAt
      if (at === generation) {
        const db = database()
        // The author's run stands for the queued one: it must not be run twice, unless the
        // scene was saved again while it ran.
        if (db !== null && !dirty.delete(id)) deleteJob(db, id)
        retryAt.delete(id)
        // It evidently works now, so whatever the queue was waiting for is over.
        paused = null
        announce(job.nodeId, 'idle', null)
      }
      return outcome.value
    } catch (err) {
      const outcome = classify(err)
      if (outcome !== 'quiet') lastRequestAt = startedAt
      if (at === generation) {
        if (err instanceof AiDisabledError) {
          // The dial or the toggle refused the author's own click: the channel answers that as
          // data, so the node goes quiet and the queue is not paused for it (nothing was sent,
          // and a background run gates itself the same way).
          announce(job.nodeId, 'idle', null)
        } else if (outcome === 'quiet') {
          const db = database()
          if (db !== null) deleteJob(db, id)
          announce(job.nodeId, 'idle', null)
        } else if (outcome === 'cancelled') {
          announce(job.nodeId, 'idle', null)
        } else {
          const failure = failureOf(err)
          // A hard failure stops the queue too: the key is missing for every job, not this one.
          if (outcome === 'hard') paused = failure
          announce(job.nodeId, 'failed', failure)
        }
      }
      throw err
    } finally {
      if (running?.id === id) running = null
      if (at === generation) {
        emit()
        kick()
      }
    }
  }

  return {
    touch(kind, nodeId) {
      const id = jobId(kind, nodeId)
      cancelTimer(id)
      // Pending from the touch, not from the run: the pane says "Updating…" through the wait.
      announce(nodeId, 'pending', null)
      timers.set(
        id,
        unref(
          setTimeout(() => {
            timers.delete(id)
            const db = database()
            if (db === null) return
            try {
              queueJob(db, kind, nodeId, true)
            } catch {
              // The node went while the debounce ran: there is nothing left to index.
              announce(nodeId, 'idle', null)
              return
            }
            emit()
            kick()
          }, debounceMs)
        )
      )
    },

    runNow(kind, nodeId, requestId) {
      const id = jobId(kind, nodeId)
      cancelTimer(id)
      const joined = active.get(id)
      if (joined !== undefined) {
        // A run for this node is already in flight or waiting its turn: join it, and make sure
        // it carries the author's id if it has not started yet.
        if (running?.id !== id) foregroundIds.set(id, requestId)
        return joined
      }
      announce(nodeId, 'pending', null)
      const at = generation
      const promise = track(
        id,
        serial(() => runForeground({ kind, nodeId }, id, requestId, at))
      )
      void promise.catch(() => undefined)
      return promise
    },

    load() {
      const db = database()
      if (db === null) return
      for (const job of listJobs(db)) {
        if (job.status === 'failed') announce(job.nodeId, 'failed', job.lastError)
        else announce(job.nodeId, 'pending', null)
      }
      emit()
      kick()
    },

    indexAll(kind, nodeIds) {
      const db = database()
      if (db === null) return 0
      let queued = 0
      for (const nodeId of nodeIds) {
        if (!queueJob(db, kind, nodeId, false)) continue
        queued += 1
        announce(nodeId, 'pending', null)
      }
      if (queued > 0) {
        emit()
        kick()
      }
      return queued
    },

    cancelAll() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (running !== null) {
        cancelRequest(running.requestId)
        // The run unwinds on its own; the queue stops counting it the moment it is stopped.
        running = null
      }
      const db = database()
      if (db !== null) deleteAllJobs(db)
      retryAt.clear()
      foregroundIds.clear()
      dirty.clear()
      paused = null
      done = 0
      for (const nodeId of [...statuses.keys()]) announce(nodeId, 'idle', null)
      const status = currentStatus()
      onChange?.(status)
      return status
    },

    resume() {
      paused = null
      const db = database()
      if (db !== null) {
        requeueFailed(db, now())
        retryAt.clear()
        for (const job of listJobs(db)) {
          if (job.status === 'queued') announce(job.nodeId, 'pending', null)
        }
      }
      const status = currentStatus()
      onChange?.(status)
      kick()
      return status
    },

    clear() {
      generation += 1
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (running !== null) cancelRequest(running.requestId)
      running = null
      statuses.clear()
      errors.clear()
      active.clear()
      foregroundIds.clear()
      retryAt.clear()
      dirty.clear()
      paused = null
      done = 0
      lastRequestAt = null
      emit()
    },

    status: () => currentStatus(),
    nodeStatus: (nodeId) => statuses.get(nodeId) ?? 'idle',
    nodeError: (nodeId) => errors.get(nodeId) ?? null
  }
}
