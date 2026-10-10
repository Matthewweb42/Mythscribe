import { EDIT_PASS_LABEL, type EditPassSummary } from '@shared/editPass'
import type { IndexQueueStatus } from '@shared/jobs'
import { CONVERSION_SECONDS_PER_SCENE } from '@shared/knowledge'
import type { OrganiseRequest } from '@shared/organise'
import type { ContinuityCheck, ContinuityOutcome } from '@renderer/features/ai/continuityStore'
import type { EditPassView } from '@renderer/features/editPass/editPassViewStore'
import type { LibraryFlow } from '@renderer/features/library/libraryStore'
import type { OrganisePhase } from '@renderer/features/organise/organiseStore'
import type { TodoCheckOutcome } from '@renderer/features/todo/todoStore'

/**
 * The background activity (F-7.12), as pure functions over what the job stores already hold: which
 * long jobs run now (`readJobs`), how far each is (`jobProgress`, real steps where the job counts
 * them, an estimated crawl otherwise), the one combined bar (`combinedProgress`), what a job's end
 * means for the author (`outcomeOf`), and when a notification has nothing left to say
 * (`noteStale`). No state of its own: the stores own every fact, `activityStore` only times them.
 * The quiet background work (scene summaries, tagging) is never a job here.
 */

export type ActivityKind =
  'organise' | 'upload' | 'editPass' | 'todoCheck' | 'continuity' | 'conversion'

/** One long job running now. */
export interface ActivityJob {
  /** Unique per run (a new run of the same kind gets a new key). */
  key: string
  kind: ActivityKind
  /** What the hover shows. */
  name: string
  /** Real progress, where the job counts it; null means the bar estimates. */
  steps: { done: number; total: number } | null
  /** The pass id (edit pass) or the scene id (consistency check) Open and Retry act on. */
  ref: string | null
}

/** What the job stores hold that the activity reads; `activityStore` takes it from each store. */
export interface ActivitySnapshot {
  organise: {
    open: boolean
    shown: boolean
    phase: OrganisePhase
    requestId: string | null
    request: OrganiseRequest | null
    error: string | null
    changes: number
  }
  upload: { flow: LibraryFlow | null; shown: boolean }
  editPasses: { byId: Record<string, EditPassSummary>; ids: string[] }
  editView: EditPassView | null
  todo: { checking: boolean; checkResult: TodoCheckOutcome | null }
  continuity: {
    running: ContinuityCheck | null
    outcome: ContinuityOutcome | null
    error: string | null
    viewOpen: boolean
  }
  conversion: { rereading: boolean }
  queue: IndexQueueStatus
}

/** A finished or failed job's notification (the drop from the top centre). */
export interface ActivityNote {
  id: string
  kind: ActivityKind
  status: 'done' | 'failed'
  title: string
  /** The result in a line, or the failure's reason with its next step. */
  detail: string | null
  ref: string | null
  /** Open shows the result (the review dialog, the report, the list). */
  canOpen: boolean
  canRetry: boolean
  /** Hidden in focus mode after its few seconds; it drops down again when focus mode ends. */
  parked: boolean
}

export type ActivityNoteDraft = Omit<ActivityNote, 'id' | 'parked'>

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Every long job running now, in a fixed order (the hover lists them so). */
export function readJobs(snap: ActivitySnapshot): ActivityJob[] {
  const jobs: ActivityJob[] = []
  const { organise, upload, editPasses, todo, continuity, conversion, queue } = snap
  if (organise.phase === 'running' && organise.requestId !== null) {
    jobs.push({
      key: `organise:${organise.requestId}`,
      kind: 'organise',
      name: 'Organise',
      steps: null,
      ref: null
    })
  }
  if (upload.flow?.stage === 'running') {
    const progress = upload.flow.progress
    jobs.push({
      key: `upload:${upload.flow.requestId}`,
      kind: 'upload',
      name: 'Upload sort',
      steps: progress === null ? null : { done: progress.done, total: progress.total },
      ref: null
    })
  }
  for (const id of editPasses.ids) {
    const pass = editPasses.byId[id]
    if (pass?.status !== 'running') continue
    jobs.push({
      key: `editPass:${pass.id}`,
      kind: 'editPass',
      name: `Edit pass · ${EDIT_PASS_LABEL[pass.type]}`,
      steps: { done: pass.doneNodeIds.length, total: pass.nodeIds.length },
      ref: pass.id
    })
  }
  if (todo.checking) {
    jobs.push({ key: 'todoCheck', kind: 'todoCheck', name: 'Book check', steps: null, ref: null })
  }
  if (continuity.running !== null) {
    jobs.push({
      key: `continuity:${continuity.running.requestId}`,
      kind: 'continuity',
      name: 'Consistency check',
      steps: null,
      ref: continuity.running.nodeId
    })
  }
  if (conversion.rereading) {
    const total = queue.done + queue.queued + queue.failed + (queue.running === null ? 0 : 1)
    jobs.push({
      key: 'conversion',
      kind: 'conversion',
      name: 'Scene card update',
      steps: total > 0 ? { done: queue.done, total } : null,
      ref: null
    })
  }
  return jobs
}

/** The crawl's ceiling: an estimate never claims more than this before the job ends. */
export const CRAWL_CAP = 0.9

/**
 * How long one step (or the whole job, without steps) is guessed to take, in ms: the crawl's
 * time constant, so it covers about 63 % of the way to the ceiling in that time and then slows.
 */
export const CRAWL_MS: Record<ActivityKind, number> = {
  organise: 25_000,
  upload: 20_000,
  editPass: 15_000,
  todoCheck: 30_000,
  continuity: 15_000,
  conversion: CONVERSION_SECONDS_PER_SCENE * 1000
}

/** The estimated share of a step done after `elapsedMs`: creeps toward `CRAWL_CAP`, never past. */
export function crawl(elapsedMs: number, timeMs: number): number {
  if (elapsedMs <= 0) return 0
  return CRAWL_CAP * (1 - Math.exp(-elapsedMs / timeMs))
}

/** When a job was first seen and when its step count last moved. */
export interface JobTiming {
  startedAt: number
  stepAt: number
  done: number
}

/**
 * How far a job is, 0–1: with steps, the steps done plus the crawl through the current one (so a
 * one-scene pass still moves); without, the crawl over the whole job. Under 1 while it runs.
 */
export function jobProgress(job: ActivityJob, timing: JobTiming | undefined, now: number): number {
  const time = CRAWL_MS[job.kind]
  if (job.steps !== null && job.steps.total > 0) {
    const { done, total } = job.steps
    const within = crawl(now - (timing?.stepAt ?? now), time)
    return Math.min(done + within, total - (1 - CRAWL_CAP)) / total
  }
  return crawl(now - (timing?.startedAt ?? now), time)
}

/** The one bar for several jobs: the average of their progress (finished ones count as 1). */
export function combinedProgress(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** What a job's end means for the author: a notification, or null (stopped, closed, or nothing to say). */
export function outcomeOf(job: ActivityJob, snap: ActivitySnapshot): ActivityNoteDraft | null {
  const base = { kind: job.kind, ref: job.ref }
  switch (job.kind) {
    case 'organise': {
      const { organise } = snap
      if (organise.phase === 'ready') {
        return {
          ...base,
          status: 'done',
          title: 'Organise is ready to review',
          detail:
            organise.changes === 0 ? 'Nothing to change.' : plural(organise.changes, 'change'),
          canOpen: true,
          canRetry: false
        }
      }
      if (organise.phase === 'failed') {
        return {
          ...base,
          status: 'failed',
          title: 'Organise failed',
          detail: organise.error,
          canOpen: true,
          canRetry: organise.request !== null
        }
      }
      return null
    }
    case 'upload': {
      const { flow } = snap.upload
      if (flow?.stage === 'review' && !flow.busy) {
        return {
          ...base,
          status: 'done',
          title: 'Upload is ready to review',
          detail: null,
          canOpen: true,
          canRetry: false
        }
      }
      if (flow?.stage === 'failed') {
        return {
          ...base,
          status: 'failed',
          title: 'Upload sort failed',
          detail: `${flow.message} ${flow.nextStep}`.trim(),
          canOpen: true,
          canRetry: true
        }
      }
      return null
    }
    case 'editPass': {
      const pass = job.ref === null ? undefined : snap.editPasses.byId[job.ref]
      if (pass === undefined) return null
      const label = EDIT_PASS_LABEL[pass.type]
      if (pass.status === 'done') {
        return {
          ...base,
          status: 'done',
          title: 'Edit pass finished',
          detail: `${label} · ${pass.counts.pending} to review`,
          canOpen: true,
          canRetry: false
        }
      }
      if (pass.status === 'failed') {
        return {
          ...base,
          status: 'failed',
          title: 'Edit pass stopped',
          detail: `${label}: ${pass.error ?? 'the pass failed.'}`,
          canOpen: true,
          canRetry: true
        }
      }
      return null
    }
    case 'todoCheck': {
      const result = snap.todo.checkResult
      if (result === null || result.status === 'cancelled') return null
      return result.status === 'done'
        ? {
            ...base,
            status: 'done',
            title: 'Book check finished',
            detail: result.message,
            canOpen: true,
            canRetry: false
          }
        : {
            ...base,
            status: 'failed',
            title: 'Book check failed',
            detail: result.message,
            canOpen: false,
            canRetry: true
          }
    }
    case 'continuity': {
      const { continuity } = snap
      if (continuity.error !== null) {
        return {
          ...base,
          status: 'failed',
          title: 'Consistency check failed',
          detail: continuity.error,
          canOpen: false,
          canRetry: job.ref !== null
        }
      }
      if (continuity.outcome !== null) {
        return {
          ...base,
          status: 'done',
          title: 'Consistency check finished',
          detail:
            continuity.outcome.found === 0
              ? 'No contradictions found.'
              : plural(continuity.outcome.found, 'finding'),
          canOpen: true,
          canRetry: false
        }
      }
      return null
    }
    case 'conversion': {
      const { queue } = snap
      if (queue.paused !== null) {
        return {
          ...base,
          status: 'failed',
          title: 'Scene card update paused',
          detail: `${queue.paused.message} ${queue.paused.nextStep}`.trim(),
          canOpen: false,
          canRetry: true
        }
      }
      if (queue.failed > 0) {
        return {
          ...base,
          status: 'failed',
          title: 'Scene card update failed',
          detail: `${plural(queue.failed, 'scene')} could not be read.`,
          canOpen: false,
          canRetry: true
        }
      }
      return {
        ...base,
        status: 'done',
        title: 'Scene cards are up to date',
        detail: null,
        canOpen: false,
        canRetry: false
      }
    }
  }
}

/**
 * Whether a notification has nothing left to say: its result already shows (the run opened in
 * the column or the dialog, the report open, the findings view open) or is gone (the run closed,
 * the pass deleted, a failure retried).
 */
export function noteStale(note: ActivityNote, snap: ActivitySnapshot): boolean {
  switch (note.kind) {
    case 'organise': {
      const { organise } = snap
      if (organise.shown) return true
      return note.status === 'done'
        ? !organise.open || organise.phase !== 'ready'
        : organise.phase !== 'failed'
    }
    case 'upload': {
      const { flow, shown } = snap.upload
      if (shown) return true
      return flow?.stage !== (note.status === 'done' ? 'review' : 'failed')
    }
    case 'editPass': {
      const pass = note.ref === null ? undefined : snap.editPasses.byId[note.ref]
      if (pass === undefined || pass.status === 'running') return true
      const view = snap.editView
      return note.status === 'done' && view?.kind === 'report' && view.passId === note.ref
    }
    case 'todoCheck':
      return snap.todo.checking
    case 'continuity':
      return (
        snap.continuity.running !== null || (note.status === 'done' && snap.continuity.viewOpen)
      )
    case 'conversion':
      return snap.conversion.rereading
  }
}
