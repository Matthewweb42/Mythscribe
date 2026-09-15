import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore, useAiActivityStore } from './aiActivityStore'

let cancels: string[]
/** What `ai:cancel` answers; a thrown value rejects. */
let cancelAnswer: () => boolean

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: cancelAnswer() } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const store = (): ReturnType<typeof useAiActivityStore.getState> => useAiActivityStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 15, 10, 0, 0))
  cancels = []
  cancelAnswer = () => true
  resetAiActivityStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(fakeClient())
})
afterEach(() => {
  resetAiActivityStore()
  vi.useRealTimers()
})

describe('useAiActivityStore (F-5.10)', () => {
  it('records a request while its promise is pending and hands the result through', async () => {
    let resolve: (value: string) => void = () => {}
    const promise = new Promise<string>((r) => {
      resolve = r
    })
    const tracked = store().track('chat', 'r-1', promise)
    const startedAt = new Date(2026, 8, 15, 10, 0, 0).getTime()
    expect(store().inflight).toEqual({ 'r-1': { feature: 'chat', startedAt } })
    expect(store().busySince).toBe(startedAt)
    resolve('answer')
    await expect(tracked).resolves.toBe('answer')
    expect(store().inflight).toEqual({})
    expect(store().busySince).toBeNull()
  })

  it('forgets a request whose promise rejects, and rejects the same way', async () => {
    const tracked = store().track('tags', 'r-2', Promise.reject(new Error('bridge down')))
    expect(Object.keys(store().inflight)).toEqual(['r-2'])
    await expect(tracked).rejects.toThrow('bridge down')
    expect(store().inflight).toEqual({})
  })

  it('keeps several requests apart, removes only the one that settled, and dates the busy spell from the first', async () => {
    let resolveGhost: (value: null) => void = () => {}
    const ghost = store().track(
      'ghostText',
      'g-1',
      new Promise<null>((r) => {
        resolveGhost = r
      })
    )
    const since = store().busySince
    vi.advanceTimersByTime(500)
    const chat = store().track('chat', 'r-3', Promise.resolve(null))
    await chat
    expect(Object.keys(store().inflight)).toEqual(['g-1'])
    expect(store().busySince).toBe(since)
    resolveGhost(null)
    await ghost
    expect(store().inflight).toEqual({})
    expect(store().busySince).toBeNull()
  })

  it('cancel asks main by id, reports whether it was still running, and never toasts', async () => {
    await expect(store().cancel('r-4')).resolves.toBe(true)
    cancelAnswer = () => false
    await expect(store().cancel('r-5')).resolves.toBe(false)
    expect(cancels).toEqual(['r-4', 'r-5'])
    expect(toasts()).toEqual([])
  })

  it('cancel swallows a transport failure: the request settles on its own', async () => {
    cancelAnswer = () => {
      throw new Error('bridge down')
    }
    await expect(store().cancel('r-6')).resolves.toBe(false)
    expect(toasts()).toEqual([])
  })

  it('cancel leaves the record to the promise: the request is in flight until its reply lands', async () => {
    let resolve: (value: null) => void = () => {}
    const tracked = store().track(
      'chat',
      'r-7',
      new Promise<null>((r) => {
        resolve = r
      })
    )
    await store().cancel('r-7')
    expect(Object.keys(store().inflight)).toEqual(['r-7'])
    resolve(null)
    await tracked
    expect(store().inflight).toEqual({})
  })

  it('a promise settling after a reset removes nothing that is not there', async () => {
    let resolve: (value: null) => void = () => {}
    const tracked = store().track(
      'chat',
      'r-8',
      new Promise<null>((r) => {
        resolve = r
      })
    )
    resetAiActivityStore()
    void store().track('tags', 'r-9', new Promise<null>(() => {}))
    resolve(null)
    await tracked
    expect(Object.keys(store().inflight)).toEqual(['r-9'])
  })
})
