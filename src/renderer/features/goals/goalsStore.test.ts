import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalsPatch, GoalsStatus } from '@shared/goals'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { goalsStatusFixture } from './goalsFixture'
import { GOALS_REFRESH_MS, resetGoalsStore, useGoalsStore } from './goalsStore'

let status: GoalsStatus
let gets: number
let patches: GoalsPatch[]
let refuse: boolean
let heldGet: ((value: GoalsStatus) => void) | null
let holdGet: boolean

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'goals:get') {
        gets += 1
        if (!holdGet) return status as Output<C>
        return new Promise<Output<C>>((resolve) => {
          heldGet = (value) => resolve(value as Output<C>)
        })
      }
      if (channel === 'goals:set') {
        const patch = input as Input<'goals:set'>
        patches.push(patch)
        if (refuse) throw new IpcRequestError({ code: 'VALIDATION', message: 'No such target' })
        status = { ...status, goals: { ...status.goals, dailyTarget: patch.dailyTarget ?? null } }
        return status as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const store = (): ReturnType<typeof useGoalsStore.getState> => useGoalsStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetGoalsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  status = goalsStatusFixture({ today: { day: '2026-10-04', words: 12 } })
  gets = 0
  patches = []
  refuse = false
  heldGet = null
  holdGet = false
  setIpcClient(client())
})
afterEach(() => {
  vi.useRealTimers()
  resetGoalsStore()
})

describe('useGoalsStore (F-10.3)', () => {
  it('loads the status and clears it', async () => {
    await store().load()
    expect(store().status?.today.words).toBe(12)
    store().show()
    store().clear()
    expect(store().status).toBeNull()
    expect(store().open).toBe(false)
  })

  it('drops a load that a clear superseded', async () => {
    holdGet = true
    const loading = store().load()
    store().clear()
    heldGet?.(status)
    await loading
    expect(store().status).toBeNull()
  })

  it('stores main’s answer to a patch', async () => {
    await store().load()
    expect(await store().set({ dailyTarget: 500 })).toBe(true)
    expect(patches).toEqual([{ dailyTarget: 500 }])
    expect(store().status?.goals.dailyTarget).toBe(500)
  })

  it('toasts a refused patch and keeps the status', async () => {
    await store().load()
    refuse = true
    expect(await store().set({ dailyTarget: 500 })).toBe(false)
    expect(store().status?.goals.dailyTarget).toBeNull()
    expect(toasts()).toEqual(['No such target'])
  })

  it('refreshes once after a burst of saves, and not before a project loaded', async () => {
    vi.useFakeTimers()
    store().refreshSoon()
    await vi.advanceTimersByTimeAsync(GOALS_REFRESH_MS * 2)
    expect(gets).toBe(0)
    await store().load()
    status = goalsStatusFixture({ today: { day: '2026-10-04', words: 40 } })
    store().refreshSoon()
    await vi.advanceTimersByTimeAsync(GOALS_REFRESH_MS / 2)
    store().refreshSoon()
    await vi.advanceTimersByTimeAsync(GOALS_REFRESH_MS / 2)
    expect(gets).toBe(1)
    await vi.advanceTimersByTimeAsync(GOALS_REFRESH_MS)
    expect(gets).toBe(2)
    expect(store().status?.today.words).toBe(40)
  })

  it('drops a pending refresh on clear', async () => {
    vi.useFakeTimers()
    await store().load()
    store().refreshSoon()
    store().clear()
    await vi.advanceTimersByTimeAsync(GOALS_REFRESH_MS * 2)
    expect(gets).toBe(1)
  })
})
