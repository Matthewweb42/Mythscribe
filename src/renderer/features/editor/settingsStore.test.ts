import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEditorSettings, type EditorSettings } from '@shared/editorSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  SETTINGS_SAVE_DELAY_MS,
  resetEditorSettingsStore,
  useEditorSettings,
  useEditorSettingsStore
} from './settingsStore'

interface PendingSet {
  value: Input<'editorSettings:set'>
  resolve: () => void
  reject: (err: Error) => void
}

/** `editorSettings:get` answers with `stored`; `editorSettings:set` resolves only when the test says so. */
function deferredClient(stored: EditorSettings): { client: IpcClient; sets: PendingSet[] } {
  const sets: PendingSet[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'editorSettings:get') return stored as Output<C>
      if (channel === 'editorSettings:set') {
        const value = input as Input<'editorSettings:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: () => resolve(value as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, sets }
}

const novel = defaultEditorSettings('novel')
let sets: PendingSet[]

const store = (): ReturnType<typeof useEditorSettingsStore.getState> =>
  useEditorSettingsStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetEditorSettingsStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient({ ...novel, fontSize: 18 })
  sets = deferred.sets
  setIpcClient(deferred.client)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useEditorSettingsStore', () => {
  it('starts empty and loads the stored settings', async () => {
    expect(store().settings).toBeNull()
    await store().load()
    expect(store().settings).toEqual({ ...novel, fontSize: 18 })
  })

  it('applies an update at once and writes it after the debounce', async () => {
    await store().load()
    store().update({ maxWidth: 900 })
    expect(store().settings?.maxWidth).toBe(900)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...novel, fontSize: 18, maxWidth: 900 })
    sets[0]?.resolve()
    await settle()
    expect(store().settings?.maxWidth).toBe(900)
  })

  it('coalesces rapid updates into one write with the merged value', async () => {
    await store().load()
    store().update({ fontSize: 20 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ lineHeight: 1.2 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ sceneBreak: '###' })
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...novel, fontSize: 20, lineHeight: 1.2, sceneBreak: '###' })
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await store().load()
    store().update({ fontSize: 20 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    store().update({ fontSize: 22 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().settings?.fontSize).toBe(20)
    expect(toasts()).toEqual(['disk full'])
  })

  it('keeps the revert baseline when a newer change is pending while a write fails', async () => {
    await store().load()
    store().update({ fontSize: 20 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().update({ fontSize: 22 }) // pending while the first write is on the wire
    sets[0]?.reject(new Error('locked'))
    await settle()
    // The optimistic value stays: the pending write will carry it.
    expect(store().settings?.fontSize).toBe(22)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[1]?.reject(new Error('locked again'))
    await settle()
    // Both failed, so the store is back at the last persisted value, not at 20.
    expect(store().settings?.fontSize).toBe(18)
    expect(toasts()).toEqual(['locked', 'locked again'])
  })

  it('ignores an out-of-range patch and one before anything is loaded', async () => {
    store().update({ fontSize: 20 })
    expect(store().settings).toBeNull()
    await store().load()
    store().update({ fontSize: 40 })
    store().update({ sceneBreak: '   ' })
    expect(store().settings).toEqual({ ...novel, fontSize: 18 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().update({ maxWidth: 600 })
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.maxWidth).toBe(600)
    sets[0]?.resolve()
    await flushing
    // Nothing left to write.
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('clear empties the store and cancels the pending write', async () => {
    await store().load()
    store().update({ maxWidth: 600 })
    store().clear()
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    await flushPendingSaves()
    expect(sets).toHaveLength(0)
  })

  it('drops the response of a load superseded by clear', async () => {
    const loading = store().load()
    store().clear()
    await loading
    expect(store().settings).toBeNull()
  })
})

describe('useEditorSettings', () => {
  it('falls back to the format defaults until the settings load', async () => {
    const { result, rerender } = renderHook(() => useEditorSettings('webnovel'))
    expect(result.current).toEqual(defaultEditorSettings('webnovel'))
    await store().load()
    rerender()
    expect(result.current).toEqual({ ...novel, fontSize: 18 })
  })
})
