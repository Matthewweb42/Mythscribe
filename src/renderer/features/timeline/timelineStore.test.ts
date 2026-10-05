import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { SceneMeta, emptySceneMeta } from '@shared/sceneMeta'
import { eventText, type TimelineEvent } from '@shared/timeline'
import {
  resetSceneMetaStore,
  useSceneMetaStore
} from '@renderer/features/editor/sceneMetaStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetTimelineStore, useTimelineStore } from './timelineStore'

const event = (id: string, label: string, when = ''): TimelineEvent => ({
  id,
  label,
  when,
  year: null,
  note: ''
})

/** Every channel invoked, in order. */
let calls: string[] = []
let storedEvents: TimelineEvent[] = []
let storedMeta: SceneMeta = emptySceneMeta()
let failSet = false

/**
 * A fake main: `timeline:set` rewrites the one scene `s1` the way main does when it is linked to
 * a renamed event, and answers it as changed.
 */
function install(): void {
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel === 'timeline:get') return { events: storedEvents } as Output<C>
      if (channel === 'sceneMeta:get') return { id: 's1', meta: storedMeta } as Output<C>
      if (channel === 'sceneMeta:set') {
        storedMeta = SceneMeta.parse((input as Input<'sceneMeta:set'>).meta)
        return { modified: 'now' } as Output<C>
      }
      if (channel === 'timeline:set') {
        if (failSet) throw new Error('disk full')
        const events = (input as Input<'timeline:set'>).events
        storedEvents = events
        const linked = events.find((e) => e.id === storedMeta.eventId)
        const changed = linked !== undefined && storedMeta.timeline !== eventText(linked)
        if (changed) storedMeta = { ...storedMeta, timeline: eventText(linked) }
        return { timeline: { events }, changedNodeIds: changed ? ['s1'] : [] } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const store = (): ReturnType<typeof useTimelineStore.getState> => useTimelineStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetTimelineStore()
  resetSceneMetaStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  storedEvents = [event('a', 'The siege begins', 'Spring')]
  storedMeta = { ...emptySceneMeta(), timeline: 'Spring: The siege begins', eventId: 'a' }
  failSet = false
  install()
})
afterEach(() => {
  resetTimelineStore()
  resetSceneMetaStore()
  setIpcClient(null)
})

describe('useTimelineStore (F-11.2)', () => {
  it('loads the stored events and clears back to none', async () => {
    expect(store()).toMatchObject({ events: [], loaded: false })
    await store().load()
    expect(store().events).toEqual(storedEvents)
    expect(store().loaded).toBe(true)
    store().clear()
    expect(store()).toMatchObject({ events: [], loaded: false })
  })

  it('flushes pending metadata, stores the list, then reloads the scenes main rewrote', async () => {
    await store().load()
    const metas = useSceneMetaStore.getState()
    await metas.load('s1')
    const loaded = useSceneMetaStore.getState().docs.s1?.content
    if (!loaded) throw new Error('not loaded')
    metas.edit('s1', { ...loaded, pov: 'mara' })
    calls = []

    expect(await store().update('a', { label: 'The siege' })).toBe(true)

    expect(calls).toEqual(['sceneMeta:set', 'timeline:set', 'sceneMeta:get'])
    expect(store().events[0]?.label).toBe('The siege')
    expect(useSceneMetaStore.getState().docs.s1?.content).toMatchObject({
      pov: 'mara',
      timeline: 'Spring: The siege',
      eventId: 'a'
    })
  })

  it('refuses a duplicate label locally, writing nothing', async () => {
    await store().load()
    calls = []
    expect(await store().add(event('b', 'the SIEGE begins'))).toBe(false)
    expect(calls).toEqual([])
    expect(store().events).toHaveLength(1)
    expect(toasts()).toEqual(['There is already an event called "the SIEGE begins"'])
  })

  it('reverts and toasts when the write fails', async () => {
    await store().load()
    failSet = true
    expect(await store().add(event('b', 'The fall'))).toBe(false)
    expect(store().events.map((e) => e.id)).toEqual(['a'])
    expect(toasts()).toHaveLength(1)
  })

  it('moves and removes through the same write', async () => {
    await store().load()
    await store().add(event('b', 'The fall'))
    await store().move(1, 0)
    expect(storedEvents.map((e) => e.id)).toEqual(['b', 'a'])
    await store().remove('b')
    expect(storedEvents.map((e) => e.id)).toEqual(['a'])
  })
})
