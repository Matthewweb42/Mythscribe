import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { defaultStoryBibleSettings } from '@shared/storyBibleSettings'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  resetStoryBibleSettingsStore,
  storyBibleSettingsNow,
  useStoryBibleSettingsStore
} from './storyBibleSettingsStore'

const state = () => useStoryBibleSettingsStore.getState()

function install(fail = false): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'storyBible:get') return defaultStoryBibleSettings() as Output<C>
      if (channel === 'storyBible:set') {
        if (fail) throw new IpcRequestError({ code: 'INTERNAL', message: 'Disk full' })
        return input as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

describe('storyBibleSettingsStore (F-9.17, F-9.19)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStoryBibleSettingsStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    resetStoryBibleSettingsStore()
    vi.useRealTimers()
  })

  it('answers the defaults until it loads, then the stored settings', async () => {
    install()
    expect(state().settings).toBeNull()
    expect(storyBibleSettingsNow()).toEqual(defaultStoryBibleSettings())
    await state().load()
    expect(state().settings).toEqual(defaultStoryBibleSettings())
  })

  it('applies a change at once and writes it once after the debounce', async () => {
    const calls = install()
    await state().load()
    state().update({ listView: 'list' })
    state().update({ defaultTemplate: 'blank' })
    expect(state().settings?.listView).toBe('list')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    const writes = calls.filter(([channel]) => channel === 'storyBible:set')
    expect(writes).toEqual([
      [
        'storyBible:set',
        { ...defaultStoryBibleSettings(), listView: 'list', defaultTemplate: 'blank' }
      ]
    ])
  })

  it('reverts a failed write and says why', async () => {
    install(true)
    await state().load()
    state().update({ listView: 'list' })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(state().settings?.listView).toBe('cards')
    expect(
      useDialogStore
        .getState()
        .toasts.map((t) => t.message)
        .join(' ')
    ).toContain('Disk full')
  })

  it('ignores a change made before the load', async () => {
    install()
    state().update({ listView: 'list' })
    expect(state().settings).toBeNull()
    await state().load()
    expect(state().settings?.listView).toBe('cards')
  })
})
