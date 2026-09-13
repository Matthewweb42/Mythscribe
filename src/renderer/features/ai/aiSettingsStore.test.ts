import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'

interface PendingSet {
  value: AiSettings
  resolve: () => void
  reject: (err: Error) => void
}

/** `aiSettings:get` answers with `stored`; `aiSettings:set` resolves only when the test says so. */
function deferredClient(stored: AiSettings): { client: IpcClient; sets: PendingSet[] } {
  const sets: PendingSet[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'aiSettings:get') return stored as Output<C>
      if (channel === 'aiSettings:set') {
        const value = input as Input<'aiSettings:set'>
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

const defaults = defaultAiSettings()
const STORED: AiSettings = { ...defaults, dial: 1 }
let sets: PendingSet[]

const store = (): ReturnType<typeof useAiSettingsStore.getState> => useAiSettingsStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAiSettingsStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient(STORED)
  sets = deferred.sets
  setIpcClient(deferred.client)
})
afterEach(() => {
  resetAiSettingsStore()
  vi.useRealTimers()
})

describe('useAiSettingsStore (F-14.4)', () => {
  it('starts empty and loads the stored settings', async () => {
    expect(store().settings).toBeNull()
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('applies a dial change at once and writes it after the debounce', async () => {
    await store().load()
    store().update({ dial: 2 })
    expect(store().settings?.dial).toBe(2)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ ...STORED, dial: 2 })
    sets[0]?.resolve()
    await settle()
    expect(store().settings?.dial).toBe(2)
  })

  it('replaces the toggles wholesale and coalesces rapid updates into one write', async () => {
    await store().load()
    store().update({ dial: 3 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ features: { ...defaults.features, ghostText: false } })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().update({ features: { ...defaults.features, ghostText: false, chat: false } })
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({
      dial: 3,
      features: { ...defaults.features, ghostText: false, chat: false }
    })
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await store().load()
    store().update({ dial: 2 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    store().update({ dial: 3 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().settings?.dial).toBe(2)
    expect(toasts()).toEqual(['disk full'])
  })

  it('keeps the revert baseline when a newer change is pending while a write fails', async () => {
    await store().load()
    store().update({ dial: 2 })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().update({ dial: 3 }) // pending while the first write is on the wire
    sets[0]?.reject(new Error('locked'))
    await settle()
    expect(store().settings?.dial).toBe(3)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[1]?.reject(new Error('locked again'))
    await settle()
    expect(store().settings?.dial).toBe(1)
    expect(toasts()).toEqual(['locked', 'locked again'])
  })

  it('ignores an update before anything is loaded', async () => {
    store().update({ dial: 2 })
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    await store().load()
    expect(store().settings).toEqual(STORED)
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().update({ dial: 0 })
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.dial).toBe(0)
    sets[0]?.resolve()
    await flushing
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('surfaces a failed flush to the caller', async () => {
    await store().load()
    store().update({ dial: 2 })
    const flushing = flushPendingSaves()
    await settle()
    sets[0]?.reject(new Error('read-only'))
    await expect(flushing).rejects.toThrow('read-only')
    expect(store().settings?.dial).toBe(1)
  })

  it('clear empties the store and cancels the pending write', async () => {
    await store().load()
    store().update({ dial: 2 })
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
