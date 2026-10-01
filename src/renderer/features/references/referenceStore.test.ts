import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { REFERENCE_PINS_MAX, type ReferencePin, type ReferencePins } from '@shared/references'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { REFERENCES_FULL_MESSAGE, resetReferenceStore, useReferenceStore } from './referenceStore'

interface PendingSet {
  value: ReferencePins
  resolve: (stored?: ReferencePins) => void
  reject: (err: Error) => void
}

const entity = (id: string): ReferencePin => ({ type: 'entity', id })
const note = (id: string): ReferencePin => ({ type: 'note', id })
const image = (file: string): ReferencePin => ({ type: 'image', file })

let stored: ReferencePins
let sets: PendingSet[]
let addAnswer: Output<'reference:addImages'> | Error
/** Resolves the `reference:get` in flight, when a test holds it open. */
let heldGet: ((value: ReferencePins) => void) | null
let holdGet: boolean

/** `reference:set` resolves only when the test says so; the other channels answer at once. */
function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'reference:get') {
        if (!holdGet) return stored as Output<C>
        return new Promise<Output<C>>((resolve) => {
          heldGet = (value) => resolve(value as Output<C>)
        })
      }
      if (channel === 'reference:set') {
        const value = input as Input<'reference:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: (answer = value) => resolve(answer as Output<C>), reject })
        })
      }
      if (channel === 'reference:addImages') {
        if (addAnswer instanceof Error) throw addAnswer
        return addAnswer as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const store = (): ReturnType<typeof useReferenceStore.getState> => useReferenceStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const panelOpen = (): boolean => useLayoutStore.getState().layout.references.open

beforeEach(() => {
  resetReferenceStore()
  resetLayoutStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = { pins: [entity('a'), note('n')] }
  sets = []
  addAnswer = null
  heldGet = null
  holdGet = false
  setIpcClient(client())
})
afterEach(() => {
  // Pinning opens the panel, which schedules the layout store's debounced write.
  resetLayoutStore()
  resetReferenceStore()
})

describe('useReferenceStore (F-9.6)', () => {
  it('starts empty and loads the pins in order', async () => {
    expect(store().pins).toEqual([])
    expect(store().loaded).toBe(false)
    await store().load()
    expect(store().pins).toEqual([entity('a'), note('n')])
    expect(store().loaded).toBe(true)
  })

  it('drops a load that a clear superseded', async () => {
    holdGet = true
    const loading = store().load()
    store().clear()
    heldGet?.(stored)
    await loading
    expect(store().pins).toEqual([])
    expect(store().loaded).toBe(false)
  })

  it('pins at the end at once, writes once, and opens the panel', async () => {
    await store().load()
    expect(panelOpen()).toBe(false)
    const pinning = store().pin(entity('b'))
    expect(store().pins).toEqual([entity('a'), note('n'), entity('b')])
    expect(panelOpen()).toBe(true)
    expect(sets.map((s) => s.value)).toEqual([{ pins: [entity('a'), note('n'), entity('b')] }])
    sets[0]?.resolve()
    await pinning
    expect(store().pins).toEqual([entity('a'), note('n'), entity('b')])
    expect(toasts()).toEqual([])
  })

  it('does not write for a target already pinned, but still opens the panel', async () => {
    await store().load()
    await store().pin(entity('a'))
    expect(sets).toHaveLength(0)
    expect(panelOpen()).toBe(true)
    // An open panel stays open.
    await store().pin(entity('a'))
    expect(panelOpen()).toBe(true)
  })

  it('refuses a pin over the maximum with a warning and no write', async () => {
    stored = { pins: Array.from({ length: REFERENCE_PINS_MAX }, (_, i) => entity(`e${i}`)) }
    await store().load()
    await store().pin(entity('one-more'))
    expect(sets).toHaveLength(0)
    expect(store().pins).toHaveLength(REFERENCE_PINS_MAX)
    expect(toasts()).toEqual([REFERENCES_FULL_MESSAGE])
    expect(panelOpen()).toBe(false)
  })

  it('unpins at once and writes the list without it; unpinning what is not pinned writes nothing', async () => {
    await store().load()
    const unpinning = store().unpin(entity('a'))
    expect(store().pins).toEqual([note('n')])
    expect(sets[0]?.value).toEqual({ pins: [note('n')] })
    sets[0]?.resolve()
    await unpinning
    await store().unpin(image('never.png'))
    expect(sets).toHaveLength(1)
  })

  it('moves a pin and writes the new order; a move that changes nothing writes nothing', async () => {
    stored = { pins: [entity('a'), entity('b'), entity('c')] }
    await store().load()
    const moving = store().move(2, 0)
    expect(store().pins).toEqual([entity('c'), entity('a'), entity('b')])
    expect(sets[0]?.value).toEqual({ pins: [entity('c'), entity('a'), entity('b')] })
    sets[0]?.resolve()
    await moving
    await store().move(0, 0)
    await store().move(0, -1)
    await store().move(9, 0)
    expect(sets).toHaveLength(1)
  })

  it('takes what main stored when it differs from what was sent', async () => {
    await store().load()
    const pinning = store().pin(entity('b'))
    sets[0]?.resolve({ pins: [note('n'), entity('b')] })
    await pinning
    expect(store().pins).toEqual([note('n'), entity('b')])
  })

  it('reverts and toasts the cause when the write is refused', async () => {
    await store().load()
    const pinning = store().pin(entity('b'))
    expect(store().pins).toHaveLength(3)
    sets[0]?.reject(new IpcRequestError({ code: 'INTERNAL', message: 'disk full' }))
    await pinning
    expect(store().pins).toEqual([entity('a'), note('n')])
    expect(toasts()).toEqual(['disk full'])
  })

  it('lets only the latest of two overlapping writes settle the list', async () => {
    stored = { pins: [entity('a'), entity('b'), entity('c')] }
    await store().load()
    const first = store().move(0, 2)
    const second = store().move(0, 1)
    expect(store().pins).toEqual([entity('c'), entity('b'), entity('a')])
    // The older answer arrives last and is ignored; so is the older failure's revert.
    sets[1]?.resolve()
    await second
    sets[0]?.reject(new IpcRequestError({ code: 'INTERNAL', message: 'late' }))
    await first
    expect(store().pins).toEqual([entity('c'), entity('b'), entity('a')])
    expect(toasts()).toEqual(['late'])
  })

  it('does not touch a store that was cleared while a write was in flight', async () => {
    await store().load()
    const pinning = store().pin(entity('b'))
    store().clear()
    sets[0]?.reject(new IpcRequestError({ code: 'INTERNAL', message: 'gone' }))
    await pinning
    expect(store().pins).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('adds images: takes the list main answers and names the skipped files', async () => {
    await store().load()
    addAnswer = {
      pins: { pins: [entity('a'), note('n'), image('map.0a1b2c3d.png')] },
      skipped: ['notes.txt', 'huge.png']
    }
    await store().addImages()
    expect(store().pins).toEqual([entity('a'), note('n'), image('map.0a1b2c3d.png')])
    expect(toasts()).toEqual([
      'Not pinned (not an image under 20 MB, or References is full): notes.txt, huge.png'
    ])
  })

  it('adds images: a cancelled dialog changes nothing, a failure toasts', async () => {
    await store().load()
    addAnswer = null
    await store().addImages()
    expect(store().pins).toEqual([entity('a'), note('n')])
    expect(toasts()).toEqual([])
    addAnswer = new IpcRequestError({ code: 'INTERNAL', message: 'no room' })
    await store().addImages()
    expect(store().pins).toEqual([entity('a'), note('n')])
    expect(toasts()).toEqual(['no room'])
  })
})
