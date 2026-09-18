import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_INDEX_QUEUE, type IndexQueueStatus } from '@shared/jobs'
import type { SummaryStatus } from '@shared/summary'
import {
  AiCancelledError,
  AiDisabledError,
  AiNetworkError,
  AiRateLimitError,
  NoKeyError
} from '../ai/providers/types'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { createIndexQueue, type IndexQueue, type JobRun, type QueuedJob } from './indexQueue'
import { enqueueJob, jobId, listJobs, markFailed } from './jobStore'

const DELAY = 3_000
const BACKOFF = [5_000, 15_000] as const

type Run = (job: QueuedJob, requestId: string) => Promise<JobRun<string>>

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let run: ReturnType<typeof vi.fn<Run>>
let events: IndexQueueStatus[]
let nodeEvents: [string, SummaryStatus][]
let cancelled: string[]
let queue: IndexQueue<string>

/** Holds a run open until `release` is called, so the in-flight window can be observed. */
function gate(value = 'done'): { promise: Promise<JobRun<string>>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<JobRun<string>>((resolve) => {
    release = () => resolve({ requested: true, value })
  })
  return { promise, release }
}

/** Lets the serial lane work through whatever the last timer started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0)
}

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

const nodesRun = (): string[] => run.mock.calls.map(([job]) => job.nodeId)
const rows = (): { nodeId: string; status: string; attempts: number }[] =>
  listJobs(db).map(({ nodeId, status, attempts }) => ({ nodeId, status, attempts }))

function build(
  over: Partial<Parameters<typeof createIndexQueue<string>>[0]> = {}
): IndexQueue<string> {
  return createIndexQueue<string>({
    db: () => db,
    run: (job, requestId) => run(job, requestId),
    cancelRequest: (requestId) => void cancelled.push(requestId),
    onChange: (status) => void events.push(status),
    onNodeStatus: (nodeId, status) => void nodeEvents.push([nodeId, status]),
    debounceMs: DELAY,
    // The rate limit has its own test; everywhere else it would only slow the clock down.
    minIntervalMs: 0,
    backoffMs: BACKOFF,
    maxAttempts: 3,
    ...over
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 17, 10, 0, 0))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-queue-'))
  session = createProject(projectFolderFor(tmp, 'Queue'), 'Queue', 'novel')
  db = session.connection.orm
  scenes = listNodes(db)
    .filter((row: NodeRow) => row.kind === 'document' && row.sectionType === null)
    .map((row) => row.id)
  run = vi.fn<Run>(async (job) => ({ requested: true, value: `ran ${job.nodeId}` }))
  events = []
  nodeEvents = []
  cancelled = []
  queue = build()
})

afterEach(() => {
  queue.clear()
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createIndexQueue (F-5.13)', () => {
  it('marks a touched node pending at once and runs its job after the debounce', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    queue.touch('summary', a)
    expect(queue.nodeStatus(a)).toBe('pending')
    expect(nodeEvents).toEqual([[a, 'pending']])
    expect(run).not.toHaveBeenCalled()

    await advance(DELAY - 1)
    expect(run).not.toHaveBeenCalled()

    await advance(1)
    expect(run).toHaveBeenCalledExactlyOnceWith({ kind: 'summary', nodeId: a }, 'job-1')
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(queue.nodeError(a)).toBeNull()
    // A finished job leaves no row: the summary it wrote and the ledger are its record.
    expect(listJobs(db)).toEqual([])
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
  })

  it('coalesces a burst of saves into one job and says nothing new while pending', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    queue.touch('summary', a)
    await advance(DELAY - 500)
    queue.touch('summary', a)
    await advance(DELAY - 500)
    queue.touch('summary', a)
    expect(run).not.toHaveBeenCalled()
    expect(nodeEvents).toEqual([[a, 'pending']])

    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(listJobs(db)).toEqual([])
  })

  it('runs one job at a time, oldest first, and counts them while they wait', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.touch('summary', a)
    await advance(1_000)
    queue.touch('summary', b)
    await advance(DELAY - 1_000)
    expect(nodesRun()).toEqual([a])

    await advance(1_000)
    // b's debounce is over and its job is queued, but a is still in flight.
    expect(nodesRun()).toEqual([a])
    expect(queue.nodeStatus(b)).toBe('pending')
    expect(queue.status()).toMatchObject({
      queued: 1,
      running: { kind: 'summary', nodeId: a },
      done: 0
    })

    first.release()
    await advance(0)
    expect(nodesRun()).toEqual([a, b])
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
  })

  it('re-queues a node saved while its own job is running, exactly once', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.touch('summary', a)
    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)

    queue.touch('summary', a)
    queue.touch('summary', a)
    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(queue.nodeStatus(a)).toBe('pending')
    expect(listJobs(db)).toHaveLength(1)

    first.release()
    await advance(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(listJobs(db)).toEqual([])
  })

  it("re-queues a node saved while the author's own run is in flight, exactly once", async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    const result = queue.runNow('summary', a, 'sum-1')
    await settle()
    expect(run).toHaveBeenCalledTimes(1)

    // A foreground run has no row of its own, so the save's debounce inserts one: it must
    // survive the run that was already in flight, or the edit is never summarised.
    queue.touch('summary', a)
    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([{ nodeId: a, status: 'queued', attempts: 0 }])

    first.release()
    expect(await result).toBe('done')
    await settle()
    expect(run).toHaveBeenCalledTimes(2)
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(listJobs(db)).toEqual([])
  })

  it('runs now: the debounce is cancelled, the request id goes through, and the result comes back', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    queue.touch('summary', a)
    const result = queue.runNow('summary', a, 'sum-1')
    await settle()
    expect(await result).toBe(`ran ${a}`)
    expect(run).toHaveBeenCalledExactlyOnceWith({ kind: 'summary', nodeId: a }, 'sum-1')
    expect(queue.nodeStatus(a)).toBe('idle')

    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins the job already in flight for the node instead of asking twice', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.touch('summary', a)
    await advance(DELAY)
    const joined = queue.runNow('summary', a, 'sum-1')
    first.release()
    await settle()
    expect(await joined).toBe('done')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('carries the request id into a job still waiting behind another node’s', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.touch('summary', a)
    await advance(1_000)
    queue.touch('summary', b)
    await advance(DELAY)
    expect(nodesRun()).toEqual([a])

    // b's job is queued but has not started: Summarize now takes it over, with the id
    // `ai:cancel` will look for, and the queued row is not run a second time.
    const joined = queue.runNow('summary', b, 'sum-2')
    first.release()
    await settle()
    expect(await joined).toBe(`ran ${b}`)
    expect(run.mock.calls.map(([job, id]) => [job.nodeId, id])).toEqual([
      [a, 'job-1'],
      [b, 'sum-2']
    ])
    expect(listJobs(db)).toEqual([])
  })

  it('resumes the jobs a project was quit with', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    enqueueJob(db, 'summary', a, new Date())
    enqueueJob(db, 'summary', b, new Date(Date.now() + 1_000))
    markFailed(
      db,
      jobId('summary', b),
      3,
      { code: 'NETWORK', message: 'The network is down.', nextStep: 'Retry.' },
      new Date()
    )

    queue.load()
    expect(queue.nodeStatus(a)).toBe('pending')
    expect(queue.nodeStatus(b)).toBe('failed')
    expect(queue.nodeError(b)?.message).toBe('The network is down.')
    await settle()
    // The queued job is picked up; the failed one waits for a Retry.
    expect(nodesRun()).toEqual([a])
    expect(rows()).toEqual([{ nodeId: b, status: 'failed', attempts: 3 }])
  })

  it('retries a transient failure with backoff and gives up after the third attempt', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValue(new AiRateLimitError('The provider is rate limiting this key.'))
    queue.touch('summary', a)
    await advance(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([{ nodeId: a, status: 'queued', attempts: 1 }])
    expect(queue.nodeStatus(a)).toBe('pending')

    await advance(BACKOFF[0] - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(rows()).toEqual([{ nodeId: a, status: 'queued', attempts: 2 }])

    await advance(BACKOFF[1])
    expect(run).toHaveBeenCalledTimes(3)
    expect(rows()).toEqual([{ nodeId: a, status: 'failed', attempts: 3 }])
    expect(queue.nodeStatus(a)).toBe('failed')
    expect(queue.nodeError(a)).toEqual({
      code: 'RATE_LIMIT',
      message: 'The provider is rate limiting this key.',
      nextStep: 'Wait a moment and retry.'
    })
    expect(queue.status()).toMatchObject({ queued: 0, running: null, failed: 1 })

    // It stays given up until the author asks again.
    await advance(BACKOFF[1] * 4)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('pauses the whole queue on a failure only the author can fix, keeping the job', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    run.mockRejectedValueOnce(new NoKeyError('No API key is saved.'))
    queue.indexAll('summary', [a, b])
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(queue.status().paused).toEqual({
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    // Both jobs are untouched: nothing was spent and nothing gave up.
    expect(rows()).toEqual([
      { nodeId: a, status: 'queued', attempts: 0 },
      { nodeId: b, status: 'queued', attempts: 0 }
    ])
    expect(queue.nodeStatus(a)).toBe('pending')

    // Nothing else runs while it is paused, however many saves land.
    queue.touch('summary', a)
    await advance(DELAY * 3)
    expect(run).toHaveBeenCalledTimes(1)

    queue.resume()
    await settle()
    expect(nodesRun()).toEqual([a, a, b])
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
  })

  it('pauses when the feature is turned off mid-queue', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValueOnce(
      new AiDisabledError('Scene summaries is turned off for this project.')
    )
    queue.indexAll('summary', [a])
    await settle()
    expect(queue.status().paused?.code).toBe('DISABLED')
    expect(rows()).toEqual([{ nodeId: a, status: 'queued', attempts: 0 }])
  })

  it('puts the failed jobs back in the queue when the author retries', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValue(new AiNetworkError('The network is down.'))
    queue.indexAll('summary', [a])
    await advance(BACKOFF[0] + BACKOFF[1])
    expect(rows()).toEqual([{ nodeId: a, status: 'failed', attempts: 3 }])

    run.mockReset()
    run.mockImplementation(async (job) => ({ requested: true, value: `ran ${job.nodeId}` }))
    const status = queue.resume()
    expect(status).toMatchObject({ queued: 1, failed: 0, paused: null })
    expect(queue.nodeStatus(a)).toBe('pending')
    await settle()
    expect(nodesRun()).toEqual([a])
    expect(listJobs(db)).toEqual([])
  })

  it('cancels everything: the running job is aborted, the table is emptied, the pause is cleared', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.indexAll('summary', [a, b])
    await settle()
    expect(queue.status()).toMatchObject({ queued: 1, running: { nodeId: a } })

    queue.touch('summary', b)
    const status = queue.cancelAll()
    expect(status).toEqual(IDLE_INDEX_QUEUE)
    expect(cancelled).toEqual(['job-1'])
    expect(listJobs(db)).toEqual([])
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(queue.nodeStatus(b)).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)

    // The aborted run comes back as CANCELLED and records nothing.
    run.mockRejectedValueOnce(new AiCancelledError('The request was stopped.'))
    first.release()
    await advance(DELAY * 2)
    expect(run).toHaveBeenCalledTimes(1)
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
  })

  it('leaves at least the minimum interval between two provider requests', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    queue.clear()
    queue = build({ minIntervalMs: 500 })
    queue.indexAll('summary', [a, b])
    await settle()
    expect(nodesRun()).toEqual([a])

    await advance(499)
    expect(nodesRun()).toEqual([a])
    await advance(1)
    expect(nodesRun()).toEqual([a, b])
  })

  it('does not wait on a job that made no request', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    queue.clear()
    queue = build({ minIntervalMs: 500 })
    // A stored summary whose content hash still matches costs nothing and waits for nothing.
    run.mockResolvedValueOnce({ requested: false, value: 'cached' })
    queue.indexAll('summary', [a, b])
    await settle()
    expect(nodesRun()).toEqual([a, b])
  })

  it('counts what is done against what is left, and starts over once it is idle', async () => {
    const [a, b, c] = scenes
    if (a === undefined || b === undefined || c === undefined) throw new Error('no scenes')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    expect(queue.indexAll('summary', [a, b, c])).toBe(3)
    await settle()
    expect(queue.status()).toMatchObject({ done: 0, queued: 2, running: { nodeId: a } })

    first.release()
    await settle()
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
    expect(nodesRun()).toEqual([a, b, c])
  })

  it('queues only what is not queued already, and answers how many were new', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    expect(queue.indexAll('summary', [a, b])).toBe(2)
    await settle()
    expect(queue.indexAll('summary', [a, b])).toBe(0)
    expect(listJobs(db)).toHaveLength(2)
    first.release()
    await settle()
    expect(nodesRun()).toEqual([a, b])
  })

  it('tells the renderer about every change, and says nothing while it is idle', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    events = []
    queue.touch('summary', a)
    // The debounce alone changes nothing the indicator shows.
    expect(events).toEqual([])
    await advance(DELAY)
    expect(events.at(0)).toMatchObject({ queued: 1, running: null })
    expect(events.at(1)).toMatchObject({ queued: 0, running: { kind: 'summary', nodeId: a } })
    expect(events.at(-1)).toEqual(IDLE_INDEX_QUEUE)
  })

  it('goes quiet for a scene that cannot be summarised, dropping its job', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValueOnce(new AppError('VALIDATION', 'Write at least 200 characters'))
    queue.touch('summary', a)
    await advance(DELAY)
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(queue.nodeError(a)).toBeNull()
    expect(listJobs(db)).toEqual([])
    expect(nodeEvents).toEqual([
      [a, 'pending'],
      [a, 'idle']
    ])
  })

  it('reads an unexpected failure as a provider problem', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValue(new Error('sqlite is busy'))
    queue.indexAll('summary', [a])
    await advance(BACKOFF[0] + BACKOFF[1])
    expect(queue.nodeError(a)).toEqual({
      code: 'PROVIDER',
      message: 'sqlite is busy',
      nextStep: 'Try again in a moment.'
    })
  })

  it('tolerates a job whose node was deleted while it waited', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.indexAll('summary', [a, scenes[1] ?? a])
    await settle()
    db.delete(node)
      .where(eq(node.id, scenes[1] ?? a))
      .run()
    first.release()
    await advance(DELAY)
    expect(nodesRun()).toEqual([a])
    expect(listJobs(db)).toEqual([])
  })

  it('leaves the node quiet and the queue unpaused when a Summarize now is refused', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValueOnce(
      new AiDisabledError('Scene summaries is turned off for this project.')
    )
    await expect(queue.runNow('summary', a, 'sum-1')).rejects.toBeInstanceOf(AiDisabledError)
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(queue.nodeError(a)).toBeNull()
    expect(queue.status().paused).toBeNull()
  })

  it('rejects from runNow with the real failure, so the channel can answer it', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValueOnce(new AiNetworkError('The network is down.'))
    await expect(queue.runNow('summary', a, 'sum-1')).rejects.toBeInstanceOf(AiNetworkError)
    expect(queue.nodeStatus(a)).toBe('failed')
    expect(queue.nodeError(a)?.code).toBe('NETWORK')
  })

  it('clears a pause when the author’s own run works', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    run.mockRejectedValueOnce(new NoKeyError('No API key is saved.'))
    queue.indexAll('summary', [a])
    await settle()
    expect(queue.status().paused?.code).toBe('NO_KEY')

    await queue.runNow('summary', a, 'sum-1')
    expect(queue.status()).toEqual(IDLE_INDEX_QUEUE)
    expect(listJobs(db)).toEqual([])
  })

  it('forgets its timers and statuses when the project changes, leaving the rows', async () => {
    const [a, b] = scenes
    if (a === undefined || b === undefined) throw new Error('no scenes')
    run.mockRejectedValue(new AiNetworkError('The network is down.'))
    queue.indexAll('summary', [a])
    await advance(BACKOFF[0] + BACKOFF[1])
    expect(queue.nodeStatus(a)).toBe('failed')

    queue.touch('summary', b)
    queue.clear()
    expect(vi.getTimerCount()).toBe(0)
    expect(queue.nodeStatus(a)).toBe('idle')
    expect(queue.nodeStatus(b)).toBe('idle')
    // The rows stay: reopening the project takes the work up again.
    expect(rows()).toEqual([{ nodeId: a, status: 'failed', attempts: 3 }])

    const before = run.mock.calls.length
    await advance(DELAY * 2)
    expect(run.mock.calls).toHaveLength(before)
  })

  it('writes nothing for a run that outlived the project it was queued in', async () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    queue.touch('summary', a)
    await advance(DELAY)
    queue.clear()
    first.release()
    await advance(0)
    expect(queue.nodeStatus(a)).toBe('idle')
    // Its row is still there, untouched by the run that finished after the project closed.
    expect(rows()).toEqual([{ nodeId: a, status: 'queued', attempts: 0 }])
  })

  it('never holds the process open: its timers are unref’d', () => {
    const [a] = scenes
    if (a === undefined) throw new Error('no scene')
    vi.useRealTimers()
    const real = build()
    real.touch('summary', a)
    // A ref'd timer would keep Node (and every handler test that saves a document) alive.
    const handles = (process as unknown as { _getActiveHandles?: () => { hasRef?(): boolean }[] })
      ._getActiveHandles
    const refd = (handles?.call(process) ?? []).filter((handle) => handle.hasRef?.() === true)
    expect(refd.some((handle) => handle.constructor.name === 'Timeout')).toBe(false)
    real.clear()
  })
})
