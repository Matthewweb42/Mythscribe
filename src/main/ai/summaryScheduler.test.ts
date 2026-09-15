import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SummaryStatus } from '@shared/summary'
import { AppError } from '../ipc/errors'
import { AiDisabledError, AiNetworkError, AiCancelledError, NoKeyError } from './providers/types'
import { createSummaryScheduler, type SummaryScheduler } from './summaryScheduler'

const DELAY = 3_000

let run: ReturnType<typeof vi.fn<(nodeId: string, requestId?: string) => Promise<string>>>
let events: [string, SummaryStatus][]
let scheduler: SummaryScheduler<string>

/** Holds a run open until `release` is called, so the in-flight window can be observed. */
function gate(): { promise: Promise<string>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<string>((resolve) => {
    release = () => resolve('done')
  })
  return { promise, release }
}

beforeEach(() => {
  vi.useFakeTimers()
  run = vi.fn(async (nodeId: string) => `ran ${nodeId}`)
  events = []
  scheduler = createSummaryScheduler<string>({
    delayMs: DELAY,
    run: (nodeId, requestId) => run(nodeId, requestId),
    onStatus: (nodeId, status) => void events.push([nodeId, status])
  })
})
afterEach(() => {
  scheduler.clear()
  vi.useRealTimers()
})

describe('createSummaryScheduler (F-5.6)', () => {
  it('marks a touched node pending at once and runs it after the debounce', async () => {
    scheduler.touch('a')
    expect(scheduler.statusOf('a')).toBe('pending')
    expect(events).toEqual([['a', 'pending']])
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DELAY - 1)
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledExactlyOnceWith('a', undefined)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.errorOf('a')).toBeNull()
    expect(events).toEqual([
      ['a', 'pending'],
      ['a', 'idle']
    ])
  })

  it('coalesces a burst of saves into one run and says nothing new while pending', async () => {
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY - 500)
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY - 500)
    scheduler.touch('a')
    expect(run).not.toHaveBeenCalled()
    expect(events).toEqual([['a', 'pending']])

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs one node at a time, in the order their debounces expired', async () => {
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    scheduler.touch('a')
    scheduler.touch('b')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run.mock.calls.map((call) => call[0])).toEqual(['a'])
    expect(scheduler.statusOf('b')).toBe('pending')

    first.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.mock.calls.map((call) => call[0])).toEqual(['a', 'b'])
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.statusOf('b')).toBe('idle')
  })

  it('re-queues a node saved while its own run is in flight, exactly once', async () => {
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run).toHaveBeenCalledTimes(1)

    scheduler.touch('a')
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.statusOf('a')).toBe('pending')

    first.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(scheduler.statusOf('a')).toBe('idle')
  })

  it('runs now: the debounce is cancelled, the request id goes through, and the result comes back', async () => {
    scheduler.touch('a')
    const result = await scheduler.runNow('a', 'sum-1')
    expect(result).toBe('ran a')
    expect(run).toHaveBeenCalledExactlyOnceWith('a', 'sum-1')
    expect(scheduler.statusOf('a')).toBe('idle')

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('carries the request id into a run still queued behind another node’s', async () => {
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    scheduler.touch('a')
    scheduler.touch('b')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(run.mock.calls.map((call) => call[0])).toEqual(['a'])

    // b's background run is queued but has not started: Summarize now joins it, and the run
    // still starts with the foreground id so `ai:cancel` can find it.
    const joined = scheduler.runNow('b', 'sum-2')
    first.release()
    await expect(joined).resolves.toBe('ran b')
    expect(run.mock.calls).toEqual([
      ['a', undefined],
      ['b', 'sum-2']
    ])
  })

  it('joins the run already in flight for the node instead of asking twice', async () => {
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    const joined = scheduler.runNow('a')
    first.release()
    expect(await joined).toBe('done')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('goes quiet when the dial or the toggle refuses the run, recording no error', async () => {
    run.mockRejectedValueOnce(new AiDisabledError('Scene summaries is turned off.'))
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.errorOf('a')).toBeNull()
    expect(events).toEqual([
      ['a', 'pending'],
      ['a', 'idle']
    ])
  })

  it('goes quiet for a scene that cannot be summarised or a stopped request', async () => {
    run.mockRejectedValueOnce(new AppError('VALIDATION', 'Write at least 200 characters'))
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('idle')

    run.mockRejectedValueOnce(new AiCancelledError('The request was stopped.'))
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.errorOf('a')).toBeNull()
  })

  it('records a provider failure with its next step, and never throws in the background', async () => {
    run.mockRejectedValueOnce(new NoKeyError('No API key is saved.'))
    scheduler.touch('a')
    // The background path swallows the rejection: advancing the clock must not throw.
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('failed')
    expect(scheduler.errorOf('a')).toEqual({
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    expect(events).toEqual([
      ['a', 'pending'],
      ['a', 'failed']
    ])

    // A run that succeeds afterwards clears the failure.
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.errorOf('a')).toBeNull()
  })

  it('reads an unexpected failure as a provider problem', async () => {
    run.mockRejectedValueOnce(new Error('sqlite is busy'))
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.errorOf('a')).toEqual({
      message: 'sqlite is busy',
      nextStep: 'Try again in a moment.'
    })
  })

  it('rejects from runNow, so the channel can answer the exact failure', async () => {
    run.mockRejectedValueOnce(new AiNetworkError('The network is down.'))
    await expect(scheduler.runNow('a')).rejects.toBeInstanceOf(AiNetworkError)
    expect(scheduler.statusOf('a')).toBe('failed')
  })

  it('forgets its timers and statuses when the project changes', async () => {
    run.mockRejectedValueOnce(new NoKeyError('No API key is saved.'))
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(scheduler.statusOf('a')).toBe('failed')

    scheduler.touch('b')
    scheduler.clear()
    expect(vi.getTimerCount()).toBe(0)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(scheduler.statusOf('b')).toBe('idle')

    const before = run.mock.calls.length
    await vi.advanceTimersByTimeAsync(DELAY * 2)
    expect(run.mock.calls).toHaveLength(before)
  })

  it('writes nothing for a run that outlived the project it was queued in', async () => {
    const first = gate()
    run.mockReturnValueOnce(first.promise)
    scheduler.touch('a')
    await vi.advanceTimersByTimeAsync(DELAY)
    scheduler.clear()
    first.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.statusOf('a')).toBe('idle')
    expect(events.filter(([, status]) => status === 'idle')).toHaveLength(0)
  })

  it('never holds the process open: its timers are unref’d', () => {
    vi.useRealTimers()
    const real = createSummaryScheduler<string>({ delayMs: DELAY, run: (id) => run(id) })
    real.touch('a')
    // A ref'd timer would keep Node (and every handler test that saves a document) alive.
    const handles = (process as unknown as { _getActiveHandles?: () => { hasRef?(): boolean }[] })
      ._getActiveHandles
    const refd = (handles?.call(process) ?? []).filter((handle) => handle.hasRef?.() === true)
    expect(refd.some((handle) => handle.constructor.name === 'Timeout')).toBe(false)
    real.clear()
  })
})
