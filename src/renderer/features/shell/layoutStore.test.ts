import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { defaultLayout, type Layout } from '@shared/layout'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  LAYOUT_SAVE_DELAY_MS,
  resetLayoutStore,
  resizePanelBy,
  useLayout,
  useLayoutStore
} from './layoutStore'

interface PendingSet {
  value: Layout
  resolve: () => void
  reject: (err: Error) => void
}

/** `layout:get` answers with `stored` (when the test releases it); `layout:set` resolves only when told. */
function deferredClient(stored: Layout): {
  client: IpcClient
  sets: PendingSet[]
  gets: (() => void)[]
} {
  const sets: PendingSet[] = []
  const gets: (() => void)[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'layout:get') {
        return new Promise<Output<C>>((resolve) => {
          gets.push(() => resolve(stored as Output<C>))
        })
      }
      if (channel === 'layout:set') {
        const value = input as Input<'layout:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: () => resolve(value as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, sets, gets }
}

const stored: Layout = {
  sidebar: { open: true, size: 0.3, tab: 'manuscript' },
  notes: { open: true, size: 0.2 }
}
let sets: PendingSet[]
let gets: (() => void)[]

const store = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Loads and releases the stored layout. */
async function load(): Promise<void> {
  const loading = store().load()
  await settle()
  gets[0]?.()
  await loading
}

beforeEach(() => {
  vi.useFakeTimers()
  resetLayoutStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient(stored)
  sets = deferred.sets
  gets = deferred.gets
  setIpcClient(deferred.client)
  vi.stubGlobal('innerWidth', 1000)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useLayoutStore', () => {
  it('starts with the defaults and loads the stored layout', async () => {
    expect(store().layout).toEqual(defaultLayout())
    await load()
    expect(store().layout).toEqual(stored)
  })

  it('applies a size at once and writes it after the debounce', async () => {
    await load()
    store().setSize('sidebar', 0.25)
    expect(store().layout.sidebar.size).toBe(0.25)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({
      ...stored,
      sidebar: { open: true, size: 0.25, tab: 'manuscript' }
    })
    sets[0]?.resolve()
    await settle()
    expect(store().layout.sidebar.size).toBe(0.25)
  })

  it('coalesces rapid changes into one write with the last value', async () => {
    await load()
    store().setSize('sidebar', 0.25)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS - 50)
    store().setSize('sidebar', 0.26)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS - 50)
    store().toggle('notes')
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({
      sidebar: { open: true, size: 0.26, tab: 'manuscript' },
      notes: { open: false, size: 0.2 }
    })
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await load()
    store().setSize('sidebar', 0.25)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    store().setSize('sidebar', 0.28)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().layout.sidebar.size).toBe(0.25)
    expect(toasts()).toEqual(['disk full'])
  })

  it('keeps the revert baseline when a newer change is pending while a write fails', async () => {
    await load()
    store().setSize('sidebar', 0.25)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().setSize('sidebar', 0.28) // pending while the first write is on the wire
    sets[0]?.reject(new Error('locked'))
    await settle()
    expect(store().layout.sidebar.size).toBe(0.28)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[1]?.reject(new Error('locked again'))
    await settle()
    expect(store().layout).toEqual(stored)
    expect(toasts()).toEqual(['locked', 'locked again'])
  })

  it('toggle flips a panel and keeps its size', async () => {
    await load()
    store().toggle('sidebar')
    expect(store().layout.sidebar).toEqual({ open: false, size: 0.3, tab: 'manuscript' })
    store().toggle('sidebar')
    expect(store().layout.sidebar).toEqual({ open: true, size: 0.3, tab: 'manuscript' })
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual(stored)
  })

  it('setSidebarTab records the tab with one debounced write and ignores the tab already shown (F-7.3)', async () => {
    await load()
    store().setSidebarTab('manuscript')
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    store().setSidebarTab('tags')
    expect(store().layout.sidebar.tab).toBe('tags')
    store().setSidebarTab('characters')
    expect(store().layout.sidebar.tab).toBe('characters')
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...stored, sidebar: { ...stored.sidebar, tab: 'characters' } })
  })

  it('a panel opening gives way so the editor keeps its minimum', async () => {
    useLayoutStore.setState({
      layout: {
        sidebar: { open: true, size: 0.35, tab: 'manuscript' },
        notes: { open: false, size: 0.5 }
      }
    })
    store().toggle('notes')
    expect(store().layout.notes.open).toBe(true)
    expect(store().layout.notes.size).toBeCloseTo(0.35)
    expect(store().layout.sidebar.size).toBe(0.35)
  })

  it('clamps a size to the panel limits and to the editor minimum, both directions', async () => {
    await load() // sidebar 0.3 and notes 0.2 open: 0.5 left for the editor
    store().setSize('sidebar', 0.05)
    expect(store().layout.sidebar.size).toBe(0.15)
    store().setSize('sidebar', 0.9)
    expect(store().layout.sidebar.size).toBe(0.35)
    // Growing the notes: 1 - 0.3 (editor) - 0.35 (sidebar) leaves 0.35 of the 0.5 it may take.
    store().setSize('notes', 0.5)
    expect(store().layout.notes.size).toBeCloseTo(0.35)
    expect(store().layout.sidebar.size).toBe(0.35)
    store().setSize('notes', 0.01)
    expect(store().layout.notes.size).toBe(0.15)
    // With the notes closed, the sidebar may use its whole range.
    store().toggle('notes')
    store().setSize('sidebar', 0.2)
    store().setSize('notes', 0.5)
    expect(store().layout.notes.size).toBeCloseTo(0.5)
    store().setSize('sidebar', 0.35)
    expect(store().layout.sidebar.size).toBe(0.35)
  })

  it('ignores a size that clamps to the current value without scheduling a write', async () => {
    await load()
    store().setSize('sidebar', 0.3)
    store().setSize('sidebar', 0.4) // clamps to 0.35
    store().setSize('sidebar', 0.35)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.sidebar.size).toBe(0.35)
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await load()
    store().toggle('sidebar')
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.sidebar.open).toBe(false)
    sets[0]?.resolve()
    await flushing
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('a change made while loading wins over the stored value', async () => {
    const loading = store().load()
    store().setSize('sidebar', 0.25)
    gets[0]?.()
    await loading
    expect(store().layout.sidebar.size).toBe(0.25)
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS)
    expect(sets[0]?.value.sidebar.size).toBe(0.25)
  })

  it('drops the response of a load superseded by a reset', async () => {
    const loading = store().load()
    resetLayoutStore()
    gets[0]?.()
    await loading
    expect(store().layout).toEqual(defaultLayout())
  })
})

describe('resizePanelBy', () => {
  it('turns a px delta into a fraction of the window width and adds it to the panel', async () => {
    await load()
    resizePanelBy('sidebar', 50)
    expect(store().layout.sidebar.size).toBeCloseTo(0.35)
    resizePanelBy('sidebar', -100)
    expect(store().layout.sidebar.size).toBeCloseTo(0.25)
    resizePanelBy('notes', 100)
    expect(store().layout.notes.size).toBeCloseTo(0.3)
  })
})

describe('useLayout', () => {
  it('follows the store', async () => {
    const { result, rerender } = renderHook(() => useLayout())
    expect(result.current).toEqual(defaultLayout())
    await load()
    rerender()
    expect(result.current).toEqual(stored)
  })
})
