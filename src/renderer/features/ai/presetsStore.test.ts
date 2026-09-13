import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { builtinParams, defaultWritingPresets, type WritingPresets } from '@shared/presets'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetPresetsStore, usePresetsStore } from './presetsStore'

interface PendingSet {
  value: WritingPresets
  resolve: () => void
  reject: (err: Error) => void
}

/** `presets:get` answers with `stored`; `presets:set` resolves only when the test says so. */
function deferredClient(stored: WritingPresets): { client: IpcClient; sets: PendingSet[] } {
  const sets: PendingSet[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'presets:get') return stored as Output<C>
      if (channel === 'presets:set') {
        const value = input as Input<'presets:set'>
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

const defaults = defaultWritingPresets()
const STORED: WritingPresets = { ...defaults, active: 'action' }
let sets: PendingSet[]

const store = (): ReturnType<typeof usePresetsStore.getState> => usePresetsStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPresetsStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient(STORED)
  sets = deferred.sets
  setIpcClient(deferred.client)
})
afterEach(() => {
  resetPresetsStore()
  vi.useRealTimers()
})

describe('usePresetsStore (F-5.2)', () => {
  it('starts empty and loads the stored presets', async () => {
    expect(store().settings).toBeNull()
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('applies a preset change at once and writes it after the debounce', async () => {
    await store().load()
    store().update({ active: 'suspense' })
    expect(store().settings?.active).toBe('suspense')
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...STORED, active: 'suspense' })
    sets[0]?.resolve()
    await settle()
    expect(store().settings?.active).toBe('suspense')
  })

  it('replaces the custom params wholesale and coalesces rapid updates into one write', async () => {
    await store().load()
    store().update({ active: 'custom' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ custom: { ...defaults.custom, temperature: 1.2 } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ custom: { ...defaults.custom, temperature: 1.2, allowNewElements: true } })
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({
      active: 'custom',
      custom: { ...defaults.custom, temperature: 1.2, allowNewElements: true }
    })
  })

  it('ignores a patch that does not parse (out-of-range custom params)', async () => {
    await store().load()
    store().update({ custom: { ...defaults.custom, temperature: 4 } })
    expect(store().settings).toEqual(STORED)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await store().load()
    store().update({ active: 'romance' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    store().update({ active: 'dialogue' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().settings?.active).toBe('romance')
    expect(toasts()).toEqual(['disk full'])
  })

  it('keeps the revert baseline when a newer change is pending while a write fails', async () => {
    await store().load()
    store().update({ active: 'romance' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().update({ active: 'dialogue' }) // pending while the first write is on the wire
    sets[0]?.reject(new Error('locked'))
    await settle()
    expect(store().settings?.active).toBe('dialogue')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[1]?.reject(new Error('locked again'))
    await settle()
    expect(store().settings?.active).toBe('action')
    expect(toasts()).toEqual(['locked', 'locked again'])
  })

  it('ignores an update before anything is loaded', async () => {
    store().update({ active: 'custom' })
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().update({ custom: builtinParams('worldBuilding') })
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.custom).toEqual(builtinParams('worldBuilding'))
    sets[0]?.resolve()
    await flushing
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('surfaces a failed flush to the caller', async () => {
    await store().load()
    store().update({ active: 'general' })
    const flushing = flushPendingSaves()
    await settle()
    sets[0]?.reject(new Error('read-only'))
    await expect(flushing).rejects.toThrow('read-only')
    expect(store().settings?.active).toBe('action')
  })

  it('clear empties the store and cancels the pending write', async () => {
    await store().load()
    store().update({ active: 'general' })
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
