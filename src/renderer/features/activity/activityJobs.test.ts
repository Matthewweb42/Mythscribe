import { describe, expect, it } from 'vitest'
import type { EditPassSummary } from '@shared/editPass'
import { IDLE_INDEX_QUEUE } from '@shared/jobs'
import { contextReviewFixture } from '@renderer/features/library/libraryFixture'
import { checkOutcome } from '@renderer/features/todo/todoStore'
import {
  combinedProgress,
  CRAWL_CAP,
  CRAWL_MS,
  crawl,
  jobProgress,
  noteStale,
  outcomeOf,
  readJobs,
  type ActivityJob,
  type ActivityNote,
  type ActivitySnapshot
} from './activityJobs'

function editPass(over: Partial<EditPassSummary> = {}): EditPassSummary {
  return {
    id: 'p1',
    type: 'proofread',
    instruction: null,
    status: 'running',
    nodeIds: ['a', 'b', 'c', 'd'],
    doneNodeIds: ['a'],
    currentNodeId: 'b',
    model: 'm',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    counts: { pending: 3, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    createdAt: '2026-10-10T10:00:00.000Z',
    finishedAt: null,
    ...over
  }
}

function snapshot(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    organise: {
      open: false,
      shown: false,
      phase: 'idle',
      requestId: null,
      request: null,
      error: null,
      changes: 0
    },
    upload: { flow: null, shown: false },
    editPasses: { byId: {}, ids: [] },
    editView: null,
    todo: { checking: false, checkResult: null },
    continuity: { running: null, outcome: null, error: null, viewOpen: false },
    conversion: { rereading: false },
    queue: IDLE_INDEX_QUEUE,
    ...over
  }
}

const note = (over: Partial<ActivityNote>): ActivityNote => ({
  id: 'n1',
  kind: 'organise',
  status: 'done',
  title: '',
  detail: null,
  ref: null,
  canOpen: true,
  canRetry: false,
  parked: false,
  ...over
})

describe('readJobs (F-7.12)', () => {
  it('reads nothing while nothing long runs, background summaries included', () => {
    expect(
      readJobs(
        snapshot({
          queue: { ...IDLE_INDEX_QUEUE, queued: 4, running: { kind: 'summary', nodeId: 'a' } }
        })
      )
    ).toEqual([])
  })

  it('reads every long job, with real steps where the job counts them', () => {
    const jobs = readJobs(
      snapshot({
        organise: { ...snapshot().organise, open: true, phase: 'running', requestId: 'org-1' },
        upload: {
          shown: false,
          flow: {
            stage: 'running',
            fileIds: ['f'],
            estimate: {
              files: 1,
              chunks: 5,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              priced: true,
              model: 'm'
            },
            requestId: 'lib-1',
            progress: { done: 2, total: 5, costUsd: 0 }
          }
        },
        editPasses: {
          byId: { p1: editPass(), p2: editPass({ id: 'p2', status: 'done' }) },
          ids: ['p1', 'p2']
        },
        todo: { checking: true, checkResult: null },
        continuity: { ...snapshot().continuity, running: { nodeId: 'a', requestId: 'c-1' } },
        conversion: { rereading: true },
        queue: {
          ...IDLE_INDEX_QUEUE,
          done: 3,
          queued: 6,
          running: { kind: 'summary', nodeId: 'x' }
        }
      })
    )
    expect(jobs.map((job) => [job.key, job.name, job.steps, job.ref])).toEqual([
      ['organise:org-1', 'Organise', null, null],
      ['upload:lib-1', 'Upload sort', { done: 2, total: 5 }, null],
      ['editPass:p1', 'Edit pass · Proofread', { done: 1, total: 4 }, 'p1'],
      ['todoCheck', 'Book check', null, null],
      ['continuity:c-1', 'Consistency check', null, 'a'],
      ['conversion', 'Scene card update', { done: 3, total: 10 }, null]
    ])
  })
})

describe('progress (F-7.12)', () => {
  const job = (over: Partial<ActivityJob> = {}): ActivityJob => ({
    key: 'k',
    kind: 'organise',
    name: 'Organise',
    steps: null,
    ref: null,
    ...over
  })

  it('crawls toward the ceiling and never past it', () => {
    expect(crawl(0, 1000)).toBe(0)
    expect(crawl(1000, 1000)).toBeCloseTo(CRAWL_CAP * (1 - Math.exp(-1)))
    expect(crawl(10_000_000, 1000)).toBeLessThanOrEqual(CRAWL_CAP)
    expect(crawl(2000, 1000)).toBeGreaterThan(crawl(1000, 1000))
  })

  it('estimates a job without steps from when it was first seen', () => {
    const timing = { startedAt: 0, stepAt: 0, done: 0 }
    expect(jobProgress(job(), timing, 0)).toBe(0)
    const later = jobProgress(job(), timing, CRAWL_MS.organise)
    expect(later).toBeGreaterThan(0.5)
    expect(later).toBeLessThan(CRAWL_CAP)
  })

  it('counts real steps and crawls through the current one, staying under the next step', () => {
    const steps = job({ kind: 'editPass', steps: { done: 1, total: 4 } })
    expect(jobProgress(steps, { startedAt: 0, stepAt: 500, done: 1 }, 500)).toBe(0.25)
    const within = jobProgress(steps, { startedAt: 0, stepAt: 0, done: 1 }, 1_000_000)
    expect(within).toBeGreaterThan(0.25)
    expect(within).toBeLessThan(0.5)
  })

  it('combines several jobs as the average, finished ones counting full', () => {
    expect(combinedProgress([])).toBe(0)
    expect(combinedProgress([0.2, 0.6, 1])).toBeCloseTo(0.6)
  })
})

describe('outcomeOf (F-7.12)', () => {
  const organise: ActivityJob = {
    key: 'organise:o',
    kind: 'organise',
    name: 'Organise',
    steps: null,
    ref: null
  }

  it('says Organise is ready to review, or failed with its reason and Retry, and nothing when stopped', () => {
    const ready = outcomeOf(
      organise,
      snapshot({ organise: { ...snapshot().organise, open: true, phase: 'ready', changes: 3 } })
    )
    expect(ready).toMatchObject({
      status: 'done',
      title: 'Organise is ready to review',
      detail: '3 changes',
      canOpen: true
    })
    const failed = outcomeOf(
      organise,
      snapshot({
        organise: {
          ...snapshot().organise,
          open: true,
          phase: 'failed',
          error: 'No key. Add one.',
          request: { instruction: '', scope: [] }
        }
      })
    )
    expect(failed).toMatchObject({
      status: 'failed',
      title: 'Organise failed',
      detail: 'No key. Add one.',
      canRetry: true
    })
    expect(outcomeOf(organise, snapshot())).toBeNull()
  })

  it('says an edit pass finished with its type, or stopped with why; a cancelled one says nothing', () => {
    const job: ActivityJob = {
      key: 'editPass:p1',
      kind: 'editPass',
      name: '',
      steps: null,
      ref: 'p1'
    }
    const at = (pass: EditPassSummary): ActivitySnapshot =>
      snapshot({ editPasses: { byId: { p1: pass }, ids: ['p1'] } })
    expect(outcomeOf(job, at(editPass({ status: 'done' })))).toMatchObject({
      title: 'Edit pass finished',
      detail: 'Proofread · 3 to review',
      canOpen: true
    })
    expect(
      outcomeOf(job, at(editPass({ status: 'failed', error: 'Rate limited.' })))
    ).toMatchObject({
      status: 'failed',
      detail: 'Proofread: Rate limited.',
      canRetry: true
    })
    expect(outcomeOf(job, at(editPass({ status: 'cancelled' })))).toBeNull()
  })

  it('carries the book check’s own result line', () => {
    const job: ActivityJob = {
      key: 'todoCheck',
      kind: 'todoCheck',
      name: '',
      steps: null,
      ref: null
    }
    const result = checkOutcome({
      ok: true,
      requested: true,
      unchanged: false,
      added: 1,
      resolved: 2,
      costUsd: 0,
      requestId: 'x'
    })
    expect(result).toEqual({ status: 'done', message: 'To do: 1 new item, 2 answered.' })
    expect(
      outcomeOf(job, snapshot({ todo: { checking: false, checkResult: result } }))
    ).toMatchObject({
      title: 'Book check finished',
      detail: 'To do: 1 new item, 2 answered.'
    })
    const cancelled = checkOutcome({
      ok: false,
      code: 'CANCELLED',
      message: '',
      nextStep: '',
      requestId: 'x'
    })
    expect(
      outcomeOf(job, snapshot({ todo: { checking: false, checkResult: cancelled } }))
    ).toBeNull()
  })

  it('says the upload is ready unless the nothing-new path is already applying it', () => {
    const job: ActivityJob = { key: 'upload:l', kind: 'upload', name: '', steps: null, ref: null }
    const review = (busy: boolean): ActivitySnapshot =>
      snapshot({
        upload: {
          shown: false,
          flow: { stage: 'review', review: contextReviewFixture(), busy, decisions: {} }
        }
      })
    expect(outcomeOf(job, review(false))).toMatchObject({ title: 'Upload is ready to review' })
    expect(outcomeOf(job, review(true))).toBeNull()
  })

  it('says the conversion re-read finished, or paused with the queue’s reason', () => {
    const job: ActivityJob = {
      key: 'conversion',
      kind: 'conversion',
      name: '',
      steps: null,
      ref: null
    }
    expect(outcomeOf(job, snapshot())).toMatchObject({ status: 'done', canOpen: false })
    const paused = snapshot({
      queue: {
        ...IDLE_INDEX_QUEUE,
        queued: 3,
        paused: { code: 'NO_KEY', message: 'No key.', nextStep: 'Add one.' }
      }
    })
    expect(outcomeOf(job, paused)).toMatchObject({
      status: 'failed',
      detail: 'No key. Add one.',
      canRetry: true
    })
  })
})

describe('noteStale (F-7.12)', () => {
  it('drops an Organise note once the run shows or closes', () => {
    const ready = snapshot({ organise: { ...snapshot().organise, open: true, phase: 'ready' } })
    expect(noteStale(note({}), ready)).toBe(false)
    expect(noteStale(note({}), { ...ready, organise: { ...ready.organise, shown: true } })).toBe(
      true
    )
    expect(noteStale(note({}), snapshot())).toBe(true)
  })

  it('drops an edit pass note once its report is open, or the pass is gone', () => {
    const done = snapshot({
      editPasses: { byId: { p1: editPass({ status: 'done' }) }, ids: ['p1'] }
    })
    const passNote = note({ kind: 'editPass', ref: 'p1' })
    expect(noteStale(passNote, done)).toBe(false)
    expect(noteStale(passNote, { ...done, editView: { kind: 'report', passId: 'p1' } })).toBe(true)
    expect(noteStale(passNote, snapshot())).toBe(true)
  })

  it('drops a consistency note while its findings view is open', () => {
    const open = snapshot({ continuity: { ...snapshot().continuity, viewOpen: true } })
    expect(noteStale(note({ kind: 'continuity' }), open)).toBe(true)
    expect(noteStale(note({ kind: 'continuity' }), snapshot())).toBe(false)
  })
})
