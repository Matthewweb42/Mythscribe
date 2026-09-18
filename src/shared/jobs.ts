import { z } from 'zod'
import { AiErrorCode } from './ai'

/**
 * The background index queue (F-5.13): the one place indexing work is run, so a burst of saves
 * (or "Summarize all scenes" over a manuscript written before F-5.6) never blocks typing, never
 * hammers the provider, and survives a quit. Main owns the queue; `index_job` holds the jobs
 * waiting and the ones that gave up, so reopening the project resumes them. A finished job
 * leaves no row: the `scene_summary` it wrote and the ledger row that paid for it are its record.
 *
 * Only `summary` jobs exist today. Embeddings (F-5.15) add a member to `JobKind` and a runner;
 * no provider batch API is used at launch (`FEATURES.md` F-5.13): OpenAI's is a 24-hour
 * asynchronous file job, and a summary feeds the story bible of the next prompt, so hours of
 * latency would leave the bible stale while the author writes. The rate-limited serial worker
 * and the content-hash short-circuit (an unchanged scene costs nothing) are the cost control.
 */

/** At least this long between the start of two provider requests made by the queue. */
export const JOB_MIN_INTERVAL_MS = 500
/** How long a transient failure waits before the job is tried again, by attempt. */
export const JOB_BACKOFF_MS = [5_000, 15_000, 45_000] as const
/** After this many attempts a transient failure becomes a `failed` row and the worker moves on. */
export const JOB_MAX_ATTEMPTS = 3

/** What a job does. One member today; a new kind is a new member and a new runner. */
export const JobKind = z.enum(['summary'])
export type JobKind = z.infer<typeof JobKind>

/** What a persisted job can be: a running job is memory-only, so a crash resumes it as queued. */
export const JobStatus = z.enum(['queued', 'failed'])
export type JobStatus = z.infer<typeof JobStatus>

/** Why a job gave up, or why the queue is paused: the AI failure shape, stored as JSON. */
export const JobFailure = z.object({
  code: AiErrorCode,
  message: z.string(),
  nextStep: z.string()
})
export type JobFailure = z.infer<typeof JobFailure>

/** What the indicator shows and `jobs:changed` carries. */
export const IndexQueueStatus = z.object({
  /** Jobs waiting (persisted rows in `queued`), the one in flight excluded. */
  queued: z.number().int().nonnegative(),
  /** The job in flight, or null. */
  running: z.object({ kind: JobKind, nodeId: z.string() }).nullable(),
  /** Rows in `failed` after their retries; the author can retry them. */
  failed: z.number().int().nonnegative(),
  /**
   * Jobs finished since the queue was last empty; back to 0 when queued, running, and failed
   * are all gone. "Indexing 3 of 12" is `done + 1` of `done + running + queued + failed`.
   */
  done: z.number().int().nonnegative(),
  /** Set while the queue is paused on a hard failure (no key, bad key, quota, budget, off); null otherwise. */
  paused: JobFailure.nullable()
})
export type IndexQueueStatus = z.infer<typeof IndexQueueStatus>

/** Nothing queued, nothing running, nothing failed: the indicator shows nothing at all. */
export const IDLE_INDEX_QUEUE: IndexQueueStatus = {
  queued: 0,
  running: null,
  failed: 0,
  done: 0,
  paused: null
}
