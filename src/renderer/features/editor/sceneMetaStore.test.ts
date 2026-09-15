import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, ParsedInput } from '@shared/ipc/contract'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AUTOSAVE_DELAY_MS, resetSceneMetaStore, useSceneMetaStore } from './sceneMetaStore'

const meta = (location: string): SceneMeta => ({ ...EMPTY_SCENE_META, location })

interface PendingGet {
  id: string
  resolve: (meta: SceneMeta) => void
  reject: (err: Error) => void
}

interface PendingSet {
  id: string
  meta: SceneMeta
  resolve: () => void
  reject: (err: Error) => void
}

/** A client whose `sceneMeta:get` and `sceneMeta:set` calls resolve only when the test says so; anything else is a failure. */
function deferredClient(): { client: IpcClient; gets: PendingGet[]; sets: PendingSet[] } {
  const gets: PendingGet[] = []
  const sets: PendingSet[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'sceneMeta:get') {
        const { id } = input as Input<'sceneMeta:get'>
        return new Promise<Output<C>>((resolve, reject) => {
          gets.push({ id, resolve: (meta) => resolve({ id, meta } as Output<C>), reject })
        })
      }
      if (channel === 'sceneMeta:set') {
        const { id, meta } = input as ParsedInput<'sceneMeta:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ id, meta, resolve: () => resolve({ modified: 'm' } as Output<C>), reject })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, gets, sets }
}

let gets: PendingGet[]
let sets: PendingSet[]

async function loaded(id: string, value: SceneMeta = meta('Stored')): Promise<void> {
  const loading = useSceneMetaStore.getState().load(id)
  gets[gets.length - 1]?.resolve(value)
  await loading
}

const store = (): ReturnType<typeof useSceneMetaStore.getState> => useSceneMetaStore.getState()
const record = (id: string): { content: SceneMeta | null; dirty: boolean } | undefined =>
  store().docs[id]

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.useFakeTimers()
  resetSceneMetaStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient()
  gets = deferred.gets
  sets = deferred.sets
  setIpcClient(deferred.client)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('useSceneMetaStore (F-4.5)', () => {
  it('loads through sceneMeta:get', async () => {
    const loading = store().load('sc-1')
    expect(record('sc-1')).toEqual({ content: null, dirty: false })
    expect(gets.map((g) => g.id)).toEqual(['sc-1'])
    gets[0]?.resolve(EMPTY_SCENE_META)
    await loading
    expect(record('sc-1')).toEqual({ content: EMPTY_SCENE_META, dirty: false })
    await loaded('ch-1', meta('the coast'))
    expect(record('ch-1')).toEqual({ content: meta('the coast'), dirty: false })
  })

  it('propagates a failed load', async () => {
    const loading = store().load('sc-1')
    gets[0]?.reject(new Error('Node not found'))
    await expect(loading).rejects.toThrow('Node not found')
  })

  it('edit marks dirty and writes the latest metadata through sceneMeta:set after the debounce', async () => {
    await loaded('sc-1')
    store().edit('sc-1', meta('d'))
    store().edit('sc-1', meta('dark-forest'))
    expect(record('sc-1')).toEqual({ content: meta('dark-forest'), dirty: true })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sets.map((s) => [s.id, s.meta])).toEqual([['sc-1', meta('dark-forest')]])
    sets[0]?.resolve()
    await settle()
    expect(record('sc-1')).toEqual({ content: meta('dark-forest'), dirty: false })
  })

  it('saveNow (Ctrl+S) writes at once and a failure toasts and keeps the record dirty', async () => {
    await loaded('sc-1')
    store().edit('sc-1', meta('now'))
    const saving = store().saveNow()
    expect(sets.map((s) => s.meta)).toEqual([meta('now')])
    sets[0]?.reject(new Error('Database is locked'))
    await saving
    expect(toasts()).toEqual(['Database is locked'])
    expect(record('sc-1')?.dirty).toBe(true)
  })

  it('unload writes the pending edit at once and forgets the record', async () => {
    await loaded('sc-1')
    store().edit('sc-1', meta('unsaved'))
    store().unload('sc-1')
    expect(sets.map((s) => [s.id, s.meta])).toEqual([['sc-1', meta('unsaved')]])
    expect(store().docs).toEqual({})
    sets[0]?.resolve()
    await settle()
    expect(toasts()).toEqual([])
  })

  it('flushPendingSaves writes pending metadata once a record has loaded and no longer after clear()', async () => {
    await flushPendingSaves()
    expect(sets).toHaveLength(0)
    await loaded('ch-1')
    store().edit('ch-1', meta('pending'))
    const flushing = flushPendingSaves()
    expect(sets.map((s) => [s.id, s.meta])).toEqual([['ch-1', meta('pending')]])
    sets[0]?.resolve()
    await flushing
    expect(record('ch-1')?.dirty).toBe(false)
    store().clear()
    expect(store().docs).toEqual({})
    await flushPendingSaves()
    expect(sets).toHaveLength(1)
  })
})
