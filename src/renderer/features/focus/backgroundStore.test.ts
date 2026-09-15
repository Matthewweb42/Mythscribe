import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Background, FocusSettings } from '@shared/focus'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { currentBackground, resetBackgroundStore, useBackgroundStore } from './backgroundStore'

interface PendingSet {
  value: FocusSettings
  resolve: () => void
  reject: (err: Error) => void
}

const bg = (id: string): Background => ({
  id,
  name: `${id}.png`,
  url: `mythscribe-asset://backgrounds/${id}.png`
})
const A = bg('a')
const B = bg('b')
const C = bg('c')

let stored: FocusSettings
let listed: Background[]
let addAnswer: Output<'background:add'>
let sets: PendingSet[]
let removed: string[]

/** `focusSettings:set` resolves only when the test says so; the other channels answer at once. */
function client(): IpcClient {
  return {
    async invoke<Ch extends Channel>(channel: Ch, input: Input<Ch>): Promise<Output<Ch>> {
      if (channel === 'focusSettings:get') return stored as Output<Ch>
      if (channel === 'background:list') return listed as Output<Ch>
      if (channel === 'background:add') return addAnswer as Output<Ch>
      if (channel === 'background:remove') {
        removed.push((input as Input<'background:remove'>).id)
        return null as Output<Ch>
      }
      if (channel === 'focusSettings:set') {
        const value = input as Input<'focusSettings:set'>
        return new Promise<Output<Ch>>((resolve, reject) => {
          sets.push({
            value: { backgroundId: value.backgroundId ?? null },
            resolve: () => resolve(value as Output<Ch>),
            reject
          })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const store = (): ReturnType<typeof useBackgroundStore.getState> => useBackgroundStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetBackgroundStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = { backgroundId: 'b' }
  listed = [A, B]
  addAnswer = null
  sets = []
  removed = []
  setIpcClient(client())
})
afterEach(() => {
  resetBackgroundStore()
  vi.useRealTimers()
})

describe('useBackgroundStore (F-6.2)', () => {
  it('starts empty and loads the settings and the list together', async () => {
    expect(store().settings).toBeNull()
    expect(store().backgrounds).toEqual([])
    expect(currentBackground(store())).toBeNull()
    await store().load()
    expect(store().settings).toEqual({ backgroundId: 'b' })
    expect(store().backgrounds).toEqual([A, B])
    expect(currentBackground(store())).toEqual(B)
  })

  it('answers no current background when the selected id has no file', async () => {
    stored = { backgroundId: 'gone' }
    await store().load()
    expect(currentBackground(store())).toBeNull()
  })

  it('selects at once and writes after the debounce', async () => {
    await store().load()
    store().select('a')
    expect(currentBackground(store())).toEqual(A)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ backgroundId: 'a' })
    sets[0]?.resolve()
    await settle()
    store().select(null)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets[1]?.value).toEqual({ backgroundId: null })
  })

  it('coalesces rapid selections into one write', async () => {
    await store().load()
    store().select('a')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().select(null)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 50)
    store().select('a')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value).toEqual({ backgroundId: 'a' })
  })

  it('reverts to the value before the failed write and toasts', async () => {
    await store().load()
    store().select('a')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    store().select(null)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(2)
    sets[0]?.resolve()
    sets[1]?.reject(new Error('disk full'))
    await settle()
    expect(store().settings).toEqual({ backgroundId: 'a' })
    expect(toasts()).toEqual(['disk full'])
  })

  it('ignores a selection before anything is loaded', async () => {
    store().select('a')
    expect(store().settings).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('adds what the dialog answered, sorted by name, and warns about skipped files', async () => {
    await store().load()
    addAnswer = { added: [C, bg('0')], skipped: ['notes.txt', 'huge.png'] }
    await store().add()
    expect(store().backgrounds.map((b) => b.id)).toEqual(['0', 'a', 'b', 'c'])
    expect(toasts()).toEqual(['Skipped (not an image under 20 MB): notes.txt, huge.png'])
  })

  it('changes nothing when the dialog is cancelled or nothing was added', async () => {
    await store().load()
    await store().add()
    expect(store().backgrounds).toEqual([A, B])
    addAnswer = { added: [], skipped: [] }
    await store().add()
    expect(store().backgrounds).toEqual([A, B])
    expect(toasts()).toEqual([])
  })

  it('removes a background and drops the selection when it was the current one, without a write', async () => {
    await store().load()
    await store().remove('a')
    expect(removed).toEqual(['a'])
    expect(store().backgrounds).toEqual([B])
    expect(store().settings).toEqual({ backgroundId: 'b' })
    await store().remove('b')
    expect(store().backgrounds).toEqual([])
    expect(store().settings).toEqual({ backgroundId: null })
    expect(currentBackground(store())).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('writes a pending selection when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().select('a')
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    sets[0]?.resolve()
    await flushing
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })

  it('surfaces a failed flush to the caller', async () => {
    await store().load()
    store().select('a')
    const flushing = flushPendingSaves()
    await settle()
    sets[0]?.reject(new Error('read-only'))
    await expect(flushing).rejects.toThrow('read-only')
    expect(store().settings).toEqual({ backgroundId: 'b' })
  })

  it('clear empties the store and cancels the pending write; a superseded load is dropped', async () => {
    await store().load()
    store().select('a')
    store().clear()
    expect(store().settings).toBeNull()
    expect(store().backgrounds).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    const loading = store().load()
    store().clear()
    await loading
    expect(store().settings).toBeNull()
  })
})
