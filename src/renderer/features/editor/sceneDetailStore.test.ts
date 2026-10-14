import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import {
  emptySceneDetails,
  type SceneDetails,
  type SceneDetailsView
} from '@shared/memory/sceneDetails'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient } from '@renderer/lib/ipc'
import { namesAny, resetSceneDetailStore, useSceneDetailStore } from './sceneDetailStore'

/**
 * F-16.11 (story memory v2): the scene detail store's own rules, apart from the pane that drives
 * it: only the newest save of a scene lands, a refused save puts the last saved details back, and
 * a roster change reads again only the loaded scenes naming one of its records.
 */

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]
let listeners: Partial<Record<EventName, ((payload: unknown) => void)[]>>
let handlers: Partial<Record<Channel, Handler>>

const view = (over: Partial<SceneDetails> = {}): SceneDetailsView => ({
  ...emptySceneDetails(),
  ...over,
  gone: []
})

function install(): void {
  calls = []
  listeners = {}
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const handler = handlers[channel]
      if (handler === undefined) throw new Error(`unexpected ${channel}`)
      return (await handler(input)) as Output<C>
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      listeners[event] = [...(listeners[event] ?? []), listener as (payload: unknown) => void]
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener)
      }
    }
  })
}

const fire = (payload: EventPayload<'record:changed'>): void => {
  for (const listener of listeners['record:changed'] ?? []) listener(payload)
}
const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)
const toasts = (): string[] => useDialogStore.getState().toasts.map((toast) => toast.message)

/** A promise and the function that settles it, for an answer the test releases by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  handlers = {}
  install()
  resetSceneDetailStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetSceneDetailStore()
  setIpcClient(null)
})

describe('sceneDetailStore (F-16.11)', () => {
  it('lets only the newest save of a scene land, whatever order the answers come in', async () => {
    handlers['sceneDetail:get'] = () => view()
    await useSceneDetailStore.getState().load('sc-1')
    const first = deferred<SceneDetailsView>()
    const second = deferred<SceneDetailsView>()
    const answers = [first, second]
    handlers['sceneDetail:set'] = () => answers.shift()?.promise
    const older = useSceneDetailStore
      .getState()
      .save('sc-1', { ...emptySceneDetails(), povRecordId: 'r-mara' })
    const newer = useSceneDetailStore
      .getState()
      .save('sc-1', { ...emptySceneDetails(), povRecordId: 'r-tomas' })
    // Optimistic: the newest choice shows at once.
    expect(useSceneDetailStore.getState().docs['sc-1']?.povRecordId).toBe('r-tomas')
    second.resolve(view({ povRecordId: 'r-tomas' }))
    await newer
    first.resolve(view({ povRecordId: 'r-mara' }))
    await older
    expect(useSceneDetailStore.getState().docs['sc-1']?.povRecordId).toBe('r-tomas')
    // A read that was under way when a save started never lands over it either.
    const read = deferred<SceneDetailsView>()
    handlers['sceneDetail:get'] = () => read.promise
    const loading = useSceneDetailStore.getState().load('sc-1')
    handlers['sceneDetail:set'] = () => view({ povRecordId: 'r-ella' })
    const saving = useSceneDetailStore
      .getState()
      .save('sc-1', { ...emptySceneDetails(), povRecordId: 'r-ella' })
    read.resolve(view({ povRecordId: 'r-mara' }))
    await Promise.all([loading, saving])
    expect(useSceneDetailStore.getState().docs['sc-1']?.povRecordId).toBe('r-ella')
  })

  it('puts the last saved details back when main refuses a save, and propagates', async () => {
    handlers['sceneDetail:get'] = () => view({ storyYear: 1811 })
    await useSceneDetailStore.getState().load('sc-1')
    handlers['sceneDetail:set'] = () => {
      throw new IpcRequestError({ code: 'VALIDATION', message: 'No such record' })
    }
    await expect(
      useSceneDetailStore
        .getState()
        .save('sc-1', { ...emptySceneDetails(), storyYear: 1811, povRecordId: 'r-gone' })
    ).rejects.toThrow('No such record')
    expect(useSceneDetailStore.getState().docs['sc-1']).toEqual(view({ storyYear: 1811 }))
  })

  it('reads again only the loaded scenes naming a record of a roster change, and drops a gone scene', async () => {
    const stored: Record<string, SceneDetailsView> = {
      'sc-1': view({ povRecordId: 'r-mara' }),
      'sc-2': view({ alsoHere: ['r-tomas'] }),
      'sc-3': view({ place: { recordId: 'r-quay', text: '' } })
    }
    handlers['sceneDetail:get'] = (input) => {
      const { nodeId } = input as Input<'sceneDetail:get'>
      const found = stored[nodeId]
      if (found === undefined) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'gone' })
      return found
    }
    for (const id of ['sc-1', 'sc-2', 'sc-3']) await useSceneDetailStore.getState().load(id)
    useSceneDetailStore.getState().subscribe()
    calls = []
    // An image change is no roster change: nothing is read.
    fire({ recordIds: ['r-mara'], roster: false })
    expect(sent('sceneDetail:get')).toEqual([])
    // Mara merged into Tomas: the scenes naming either are read; the place scene is not.
    stored['sc-1'] = view({ povRecordId: 'r-tomas' })
    delete stored['sc-2']
    fire({ recordIds: ['r-tomas', 'r-mara'], roster: true })
    await vi.waitFor(() =>
      expect(useSceneDetailStore.getState().docs['sc-1']?.povRecordId).toBe('r-tomas')
    )
    expect(sent('sceneDetail:get')).toEqual([{ nodeId: 'sc-1' }, { nodeId: 'sc-2' }])
    // A scene deleted meanwhile has no details to show any more, and no toast says so.
    await vi.waitFor(() => expect(useSceneDetailStore.getState().docs['sc-2']).toBeUndefined())
    expect(useSceneDetailStore.getState().docs['sc-3']).toBeDefined()
    expect(toasts()).toEqual([])
  })

  it('names a record in any of the details that point at one', () => {
    const ids = new Set(['r-1'])
    expect(namesAny(view({ povRecordId: 'r-1' }), ids)).toBe(true)
    expect(namesAny(view({ place: { recordId: 'r-1', text: '' } }), ids)).toBe(true)
    expect(namesAny(view({ alsoHere: ['r-2', 'r-1'] }), ids)).toBe(true)
    expect(namesAny({ ...view(), gone: ['r-1'] }, ids)).toBe(true)
    expect(namesAny(view({ povRecordId: 'r-2' }), ids)).toBe(false)
  })

  it('sets the Flashback switch over the stored details, read first, and answers the old one (2026-10-14)', async () => {
    handlers['sceneDetail:get'] = () => view({ storyYear: 1798, alsoHere: ['r-1'] })
    handlers['sceneDetail:set'] = (input) => {
      const { details } = input as Input<'sceneDetail:set'>
      return { ...details, gone: [] }
    }
    // Not loaded yet: read, then saved with everything else kept.
    expect(await useSceneDetailStore.getState().setFlashback('sc-1', false)).toBeNull()
    expect(sent('sceneDetail:get')).toEqual([{ nodeId: 'sc-1' }])
    expect(sent('sceneDetail:set')).toEqual([
      {
        nodeId: 'sc-1',
        details: { ...emptySceneDetails(), storyYear: 1798, alsoHere: ['r-1'], flashback: false }
      }
    ])
    expect(useSceneDetailStore.getState().docs['sc-1']?.flashback).toBe(false)
    // Loaded: no read; the old value comes back for Undo.
    expect(await useSceneDetailStore.getState().setFlashback('sc-1', null)).toBe(false)
    expect(sent('sceneDetail:get')).toHaveLength(1)
    expect(useSceneDetailStore.getState().docs['sc-1']?.flashback).toBeNull()
  })

  it('with an expected value, writes only while the switch still holds it (Undo, review 2026-10-14)', async () => {
    handlers['sceneDetail:get'] = () => view({ flashback: false })
    handlers['sceneDetail:set'] = (input) => {
      const { details } = input as Input<'sceneDetail:set'>
      return { ...details, gone: [] }
    }
    // The switch says Not a flashback, as expected: the Undo lands.
    expect(await useSceneDetailStore.getState().setFlashback('sc-1', null, false)).toBe(false)
    expect(sent('sceneDetail:set')).toHaveLength(1)
    // It was changed since (now following the book): nothing is sent, and the answer says so.
    expect(await useSceneDetailStore.getState().setFlashback('sc-1', true, false)).toBeNull()
    expect(sent('sceneDetail:set')).toHaveLength(1)
    expect(useSceneDetailStore.getState().docs['sc-1']?.flashback).toBeNull()
  })
})
