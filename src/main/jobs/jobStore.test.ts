import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobFailure } from '@shared/jobs'
import { indexJob, node, type NodeRow } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import {
  bumpAttempts,
  deleteAllJobs,
  deleteJob,
  enqueueJob,
  getJob,
  jobId,
  listJobs,
  markFailed,
  requeueFailed
} from './jobStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

const FAILURE: JobFailure = {
  code: 'RATE_LIMIT',
  message: 'The provider is rate limiting this key.',
  nextStep: 'Wait a moment and retry.'
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 17, 10, minute, 0))

function documents(): NodeRow[] {
  return listNodes(db).filter((row) => row.kind === 'document' && row.sectionType === null)
}

function scene(index = 0): NodeRow {
  const row = documents()[index]
  if (!row) throw new Error(`no document at ${index}`)
  return row
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-jobs-'))
  session = createProject(projectFolderFor(tmp, 'Jobs'), 'Jobs', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('jobStore (F-5.13)', () => {
  it('has no jobs in a fresh project', () => {
    expect(listJobs(db)).toEqual([])
    expect(getJob(db, 'summary:nope')).toBeNull()
  })

  it('queues one job per kind and node and reads it back', () => {
    expect(enqueueJob(db, 'summary', scene().id, at(0))).toBe(true)
    const jobs = listJobs(db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toEqual({
      id: jobId('summary', scene().id),
      kind: 'summary',
      nodeId: scene().id,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: at(0).toISOString(),
      updatedAt: at(0).toISOString()
    })
  })

  it('keeps the order jobs were queued in when they were queued in the same moment', () => {
    enqueueJob(db, 'summary', scene(1).id, at(0))
    enqueueJob(db, 'summary', scene(0).id, at(0))
    enqueueJob(db, 'summary', scene(2).id, at(0))
    expect(listJobs(db).map((job) => job.nodeId)).toEqual([scene(1).id, scene(0).id, scene(2).id])
  })

  it('leaves a queued job exactly where it was when the node is touched again', () => {
    enqueueJob(db, 'summary', scene(0).id, at(0))
    enqueueJob(db, 'summary', scene(1).id, at(1))
    expect(enqueueJob(db, 'summary', scene(0).id, at(2))).toBe(false)
    expect(listJobs(db).map((job) => job.nodeId)).toEqual([scene(0).id, scene(1).id])
    expect(getJob(db, jobId('summary', scene(0).id))?.createdAt).toBe(at(0).toISOString())
  })

  it('brings a failed job back to the queue with its attempts and error cleared', () => {
    const id = jobId('summary', scene().id)
    enqueueJob(db, 'summary', scene().id, at(0))
    markFailed(db, id, 3, FAILURE, at(1))
    expect(getJob(db, id)).toMatchObject({ status: 'failed', attempts: 3, lastError: FAILURE })

    expect(enqueueJob(db, 'summary', scene().id, at(2))).toBe(true)
    expect(getJob(db, id)).toMatchObject({ status: 'queued', attempts: 0, lastError: null })
    expect(listJobs(db)).toHaveLength(1)
  })

  it('records another try without moving the job or losing its place', () => {
    const id = jobId('summary', scene().id)
    enqueueJob(db, 'summary', scene().id, at(0))
    bumpAttempts(db, id, 2, at(1))
    expect(getJob(db, id)).toMatchObject({
      status: 'queued',
      attempts: 2,
      createdAt: at(0).toISOString(),
      updatedAt: at(1).toISOString()
    })
  })

  it('deletes a finished job and says nothing about one that is already gone', () => {
    const id = jobId('summary', scene().id)
    enqueueJob(db, 'summary', scene().id, at(0))
    deleteJob(db, id)
    expect(getJob(db, id)).toBeNull()
    expect(() => deleteJob(db, id)).not.toThrow()
  })

  it('empties the queue, failed rows included', () => {
    enqueueJob(db, 'summary', scene(0).id, at(0))
    enqueueJob(db, 'summary', scene(1).id, at(1))
    markFailed(db, jobId('summary', scene(1).id), 3, FAILURE, at(2))
    deleteAllJobs(db)
    expect(listJobs(db)).toEqual([])
  })

  it('puts every failed job back in the queue and counts them', () => {
    enqueueJob(db, 'summary', scene(0).id, at(0))
    enqueueJob(db, 'summary', scene(1).id, at(1))
    markFailed(db, jobId('summary', scene(1).id), 3, FAILURE, at(2))
    expect(requeueFailed(db, at(3))).toBe(1)
    expect(listJobs(db).map((job) => [job.status, job.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0]
    ])
    expect(requeueFailed(db, at(4))).toBe(0)
  })

  it('goes with the scene: deleting the node drops its job', () => {
    const id = scene().id
    enqueueJob(db, 'summary', id, at(0))
    db.delete(node).where(eq(node.id, id)).run()
    expect(listJobs(db)).toEqual([])
  })

  it('reads a corrupt error as a generic provider failure instead of throwing', () => {
    const id = jobId('summary', scene().id)
    enqueueJob(db, 'summary', scene().id, at(0))
    markFailed(db, id, 3, FAILURE, at(1))
    db.update(indexJob).set({ lastError: '{not json' }).where(eq(indexJob.id, id)).run()
    expect(getJob(db, id)?.lastError).toEqual({
      code: 'PROVIDER',
      message: 'The last attempt failed.',
      nextStep: 'Try again in a moment.'
    })
  })

  it('skips a job whose kind this build does not know', () => {
    enqueueJob(db, 'summary', scene(0).id, at(0))
    enqueueJob(db, 'summary', scene(1).id, at(1))
    db.update(indexJob)
      .set({ kind: 'embedding' })
      .where(eq(indexJob.id, jobId('summary', scene(1).id)))
      .run()
    expect(listJobs(db).map((job) => job.nodeId)).toEqual([scene(0).id])
    expect(getJob(db, jobId('summary', scene(1).id))).toBeNull()
  })
})
