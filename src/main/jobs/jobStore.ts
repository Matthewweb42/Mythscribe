import { asc, eq, sql } from 'drizzle-orm'
import { JobFailure, JobKind, JobStatus } from '@shared/jobs'
import { indexJob, type IndexJobRow } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * The `index_job` rows (F-5.13): the jobs the background queue still has to do, and the ones
 * that gave up. `src/main/jobs/indexQueue.ts` is the only caller; it keeps what is running, the
 * debounce windows, and the pause in memory, so a crash leaves a running job as `queued` and
 * reopening the project resumes it.
 *
 * A row that no longer parses (an unknown kind or status from a newer build, a hand-edited
 * `last_error`) never throws here: an unreadable kind or status is skipped by `listJobs`, and an
 * unreadable error reads as a generic PROVIDER failure, so the author sees "try again", not a
 * crash.
 */

/** One job as the queue reads it: the stored row with its kind, status, and error parsed. */
export interface IndexJob {
  id: string
  kind: JobKind
  nodeId: string
  status: JobStatus
  attempts: number
  lastError: JobFailure | null
  createdAt: string
  updatedAt: string
}

/** What an unreadable `last_error` reads as: something went wrong, try again. */
const UNREADABLE: JobFailure = {
  code: 'PROVIDER',
  message: 'The last attempt failed.',
  nextStep: 'Try again in a moment.'
}

/** `<kind>:<nodeId>`: one job per kind and node, so a burst of saves cannot pile up rows. */
export function jobId(kind: JobKind, nodeId: string): string {
  return `${kind}:${nodeId}`
}

/**
 * Every job, oldest first; jobs queued in the same moment (one "Summarize all scenes" click)
 * keep the order they were inserted in, so the queue works through the book from the front.
 */
export function listJobs(db: TreeDb): IndexJob[] {
  return db
    .select()
    .from(indexJob)
    .orderBy(asc(indexJob.createdAt), sql`rowid`)
    .all()
    .map(toJob)
    .filter((job): job is IndexJob => job !== null)
}

/** One job by id, or null when it is gone (cancelled, or its node was deleted). */
export function getJob(db: TreeDb, id: string): IndexJob | null {
  const row = db.select().from(indexJob).where(eq(indexJob.id, id)).get()
  return row === undefined ? null : toJob(row)
}

/**
 * Queues a job for a node. A job already `queued` is left exactly as it is (same `createdAt`,
 * so its place in the queue is kept); a `failed` one comes back as `queued` with its attempts
 * and its error cleared, which is what "try again" means. Returns whether there is now work
 * to do that was not queued before.
 */
export function enqueueJob(db: TreeDb, kind: JobKind, nodeId: string, now: Date): boolean {
  const id = jobId(kind, nodeId)
  const existing = getJob(db, id)
  if (existing !== null && existing.status === 'queued') return false
  const at = now.toISOString()
  db.insert(indexJob)
    .values({
      id,
      kind,
      nodeId,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: at,
      updatedAt: at
    })
    .onConflictDoUpdate({
      target: indexJob.id,
      set: { status: 'queued', attempts: 0, lastError: null, updatedAt: at }
    })
    .run()
  return true
}

/** Records another try of a job that failed transiently; the row stays `queued`. */
export function bumpAttempts(db: TreeDb, id: string, attempts: number, now: Date): void {
  db.update(indexJob)
    .set({ attempts, updatedAt: now.toISOString() })
    .where(eq(indexJob.id, id))
    .run()
}

/** The job gave up: the row goes `failed` and carries why, where the author can retry it. */
export function markFailed(
  db: TreeDb,
  id: string,
  attempts: number,
  failure: JobFailure,
  now: Date
): void {
  db.update(indexJob)
    .set({
      status: 'failed',
      attempts,
      lastError: JSON.stringify(failure),
      updatedAt: now.toISOString()
    })
    .where(eq(indexJob.id, id))
    .run()
}

/** The job is done (or there is nothing to do): its row goes. A missing row is a no-op. */
export function deleteJob(db: TreeDb, id: string): void {
  db.delete(indexJob).where(eq(indexJob.id, id)).run()
}

/** Empties the queue (Cancel, F-5.13): every waiting and failed job goes. */
export function deleteAllJobs(db: TreeDb): void {
  db.delete(indexJob).run()
}

/** Puts every failed job back in the queue with its attempts reset; returns how many moved. */
export function requeueFailed(db: TreeDb, now: Date): number {
  const result = db
    .update(indexJob)
    .set({ status: 'queued', attempts: 0, lastError: null, updatedAt: now.toISOString() })
    .where(eq(indexJob.status, 'failed'))
    .run()
  return result.changes
}

/** A stored row as the queue reads it; null when its kind or status is not one this build knows. */
function toJob(row: IndexJobRow): IndexJob | null {
  const kind = JobKind.safeParse(row.kind)
  const status = JobStatus.safeParse(row.status)
  if (!kind.success || !status.success) return null
  return {
    id: row.id,
    kind: kind.data,
    nodeId: row.nodeId,
    status: status.data,
    attempts: row.attempts,
    lastError: status.data === 'failed' ? parseFailure(row.lastError) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function parseFailure(raw: string | null): JobFailure {
  if (raw === null) return UNREADABLE
  try {
    const parsed = JobFailure.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : UNREADABLE
  } catch {
    return UNREADABLE
  }
}
