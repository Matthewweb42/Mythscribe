import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AUTOSAVE_DELAY_MS, resetDocumentStore, useDocumentStore } from './documentStore'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})
const hello = para('Hello')

interface PendingGet {
  id: string
  resolve: (content: TiptapNodeT | null) => void
  reject: (err: Error) => void
}

interface PendingSave {
  id: string
  content: TiptapNodeT
  resolve: (wordCount: number) => void
  reject: (err: Error) => void
}

/** A client whose `document:get` and `document:save` calls resolve only when the test says so. */
function deferredClient(): { client: IpcClient; gets: PendingGet[]; saves: PendingSave[] } {
  const gets: PendingGet[] = []
  const saves: PendingSave[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'document:get') {
        const { id } = input as Input<'document:get'>
        return new Promise<Output<C>>((resolve, reject) => {
          gets.push({ id, resolve: (content) => resolve({ id, content } as Output<C>), reject })
        })
      }
      if (channel === 'document:save') {
        const { id, content } = input as Input<'document:save'>
        return new Promise<Output<C>>((resolve, reject) => {
          saves.push({
            id,
            content,
            resolve: (wordCount) => resolve({ wordCount, modified: 'm' } as Output<C>),
            reject
          })
        })
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, gets, saves }
}

let gets: PendingGet[]
let saves: PendingSave[]

/** Loads `id` and resolves its `document:get` with `content`. */
async function loaded(id: string, content: TiptapNodeT | null = hello): Promise<void> {
  const loading = useDocumentStore.getState().load(id)
  gets[gets.length - 1]?.resolve(content)
  await loading
}

/** Lets the microtasks behind an un-awaited flush run. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.useFakeTimers()
  resetDocumentStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  resetPendingSaves()
  const deferred = deferredClient()
  gets = deferred.gets
  saves = deferred.saves
  setIpcClient(deferred.client)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('useDocumentStore load', () => {
  it('sets the id at once and the content when document:get resolves', async () => {
    const loading = useDocumentStore.getState().load('scene-1')
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-1', content: null })
    gets[0]?.resolve(hello)
    await loading
    expect(useDocumentStore.getState()).toMatchObject({
      id: 'scene-1',
      content: hello,
      dirty: false
    })
  })

  it('loads a never-written document as the empty document', async () => {
    await loaded('scene-1', null)
    expect(useDocumentStore.getState().content).toEqual(EMPTY_DOC)
  })

  it('drops a response from a superseded load', async () => {
    const first = useDocumentStore.getState().load('scene-1')
    const second = useDocumentStore.getState().load('scene-2')
    gets[1]?.resolve(hello)
    await second
    gets[0]?.resolve(EMPTY_DOC)
    await first
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-2', content: hello })
  })

  it('drops a response that arrives after clear()', async () => {
    const loading = useDocumentStore.getState().load('scene-1')
    useDocumentStore.getState().clear()
    gets[0]?.resolve(hello)
    await loading
    expect(useDocumentStore.getState()).toMatchObject({ id: null, content: null })
  })

  it('resets dirty on load and clear, and propagates load errors', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('x'))
    expect(useDocumentStore.getState().dirty).toBe(true)
    const loading = useDocumentStore.getState().load('scene-2')
    expect(useDocumentStore.getState().dirty).toBe(false)
    gets[1]?.reject(new Error('Database is locked'))
    await expect(loading).rejects.toThrow('Database is locked')
    useDocumentStore.getState().edit(para('y'))
    useDocumentStore.getState().clear()
    expect(useDocumentStore.getState().dirty).toBe(false)
  })
})

describe('useDocumentStore autosave (F-3.2)', () => {
  it('edit marks dirty and saves the latest content after the debounce, then clears dirty', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('Hello w'))
    expect(useDocumentStore.getState().dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('Hello w')]])
    expect(useDocumentStore.getState().dirty).toBe(true)
    saves[0]?.resolve(2)
    await settle()
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('coalesces edits within the debounce window into one save with the latest content', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('a'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100)
    useDocumentStore.getState().edit(para('ab'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(saves.map((s) => s.content)).toEqual([para('ab')])
  })

  it('ignores edits while no document is loaded', async () => {
    useDocumentStore.getState().edit(para('lost'))
    expect(useDocumentStore.getState().dirty).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(0)
  })

  it('saveNow saves immediately and cancels the debounce timer', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('now'))
    const saving = useDocumentStore.getState().saveNow()
    expect(saves.map((s) => s.content)).toEqual([para('now')])
    saves[0]?.resolve(1)
    await saving
    expect(useDocumentStore.getState().dirty).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(1)
  })

  it('saveNow and the timer do nothing when there is nothing pending', async () => {
    await loaded('scene-1')
    await useDocumentStore.getState().saveNow()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(0)
  })

  it('a failed save toasts, keeps dirty, and retries the same job on the next saveNow', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('keep me'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    saves[0]?.reject(new Error('Database is locked'))
    await settle()
    expect(toasts()).toEqual(['Database is locked'])
    expect(useDocumentStore.getState().dirty).toBe(true)

    const retry = useDocumentStore.getState().saveNow()
    expect(saves.map((s) => s.content)).toEqual([para('keep me'), para('keep me')])
    saves[1]?.resolve(2)
    await retry
    expect(useDocumentStore.getState().dirty).toBe(false)
    expect(toasts()).toEqual(['Database is locked'])
  })

  it('a newer edit made during a failing save wins over the failed job', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('old'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    useDocumentStore.getState().edit(para('new'))
    saves[0]?.reject(new Error('boom'))
    await settle()
    expect(toasts()).toEqual(['boom'])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves.map((s) => s.content)).toEqual([para('old'), para('new')])
    saves[1]?.resolve(1)
    await settle()
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('stays dirty when an edit lands while a save is in flight', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('one'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    useDocumentStore.getState().edit(para('two'))
    saves[0]?.resolve(1)
    await settle()
    expect(useDocumentStore.getState().dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves.map((s) => s.content)).toEqual([para('one'), para('two')])
    saves[1]?.resolve(1)
    await settle()
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('loading another document saves the pending edit under the old id without waiting', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('unsaved'))
    const loading = useDocumentStore.getState().load('scene-2')
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('unsaved')]])
    expect(useDocumentStore.getState()).toMatchObject({
      id: 'scene-2',
      content: null,
      dirty: false
    })
    gets[1]?.resolve(para('Second'))
    await loading
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-2', content: para('Second') })
    // The old save resolving later does not touch the new document's dirty flag.
    useDocumentStore.getState().edit(para('Second!'))
    saves[0]?.resolve(1)
    await settle()
    expect(useDocumentStore.getState().dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves[1]).toMatchObject({ id: 'scene-2', content: para('Second!') })
  })

  it('a failed save during a document switch toasts instead of failing the load', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('unsaved'))
    const loading = useDocumentStore.getState().load('scene-2')
    saves[0]?.reject(new Error('disk full'))
    gets[1]?.resolve(hello)
    await loading
    await settle()
    expect(toasts()).toEqual(['disk full'])
    expect(useDocumentStore.getState()).toMatchObject({ id: 'scene-2', content: hello })
  })

  it('flushPendingSaves runs the flush after a load and no longer after clear()', async () => {
    await flushPendingSaves()
    expect(saves).toHaveLength(0)

    await loaded('scene-1')
    useDocumentStore.getState().edit(para('pending'))
    const flushing = flushPendingSaves()
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('pending')]])
    saves[0]?.resolve(1)
    await flushing
    expect(useDocumentStore.getState().dirty).toBe(false)

    useDocumentStore.getState().edit(para('failing'))
    const failing = flushPendingSaves()
    saves[1]?.reject(new Error('locked'))
    await expect(failing).rejects.toThrow('locked')
    expect(useDocumentStore.getState().dirty).toBe(true)

    useDocumentStore.getState().clear()
    expect(saves).toHaveLength(3) // clear() flushed the retried job
    saves[2]?.resolve(1)
    await settle()
    await flushPendingSaves()
    expect(saves).toHaveLength(3)
  })

  it('flushPendingSaves waits for a debounced save that is already on the wire', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('typed'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(1)
    let flushed = false
    const flushing = flushPendingSaves().then(() => {
      flushed = true
    })
    await settle()
    expect(flushed).toBe(false) // the in-flight write has not resolved yet
    saves[0]?.resolve(1)
    await flushing
    expect(saves).toHaveLength(1)
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('serializes a later edit behind a save that is in flight', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('first'))
    const first = useDocumentStore.getState().saveNow()
    useDocumentStore.getState().edit(para('second'))
    const second = useDocumentStore.getState().saveNow()
    await settle()
    expect(saves).toHaveLength(1) // the second write waits for the first
    saves[0]?.resolve(1)
    await first
    await settle()
    expect(saves.map((s) => s.content)).toEqual([para('first'), para('second')])
    saves[1]?.resolve(1)
    await second
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('clear() flushes the pending edit and drops the registration once', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    useDocumentStore.getState().edit(para('last words'))
    useDocumentStore.getState().clear()
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-2', para('last words')]])
    expect(useDocumentStore.getState()).toMatchObject({ id: null, content: null, dirty: false })
    saves[0]?.resolve(2)
    await settle()
    await flushPendingSaves()
    expect(saves).toHaveLength(1)
  })

  it('keeps a failed save for the previous document when the new document is edited meanwhile', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('A-edit'))
    const saving = useDocumentStore.getState().saveNow() // scene-1's write is now on the wire
    const loading = useDocumentStore.getState().load('scene-2') // waits on that write, then switches
    gets[1]?.resolve(hello)
    useDocumentStore.getState().edit(para('B-edit')) // lands while scene-1 is still saving
    saves[0]?.reject(new Error('boom'))
    await loading
    await saving
    await settle()
    expect(toasts()).toEqual(['boom'])
    // The switch's flush wakes when scene-1's write settles and sends everything pending: scene-2's
    // edit (queued first) and then scene-1's failed edit, which was re-queued when its write failed.
    expect(saves.slice(1).map((s) => [s.id, s.content])).toEqual([['scene-2', para('B-edit')]])
    saves[1]?.resolve(1)
    await settle()
    expect(saves.slice(2).map((s) => [s.id, s.content])).toEqual([['scene-1', para('A-edit')]])
    expect(useDocumentStore.getState().dirty).toBe(false)
    saves[2]?.resolve(1)
    await settle()
    expect(saves).toHaveLength(3)
  })

  it('a failed save for another document leaves the current one dirty until both are written', async () => {
    await loaded('scene-1')
    useDocumentStore.getState().edit(para('A-edit'))
    await loaded('scene-2') // flushes scene-1 without waiting
    saves[0]?.reject(new Error('locked'))
    await settle()
    useDocumentStore.getState().edit(para('B-edit'))
    const saving = useDocumentStore.getState().saveNow()
    await settle()
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-1'])
    saves[1]?.resolve(1)
    await settle()
    saves[2]?.resolve(1)
    await saving
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-1', 'scene-2'])
    expect(useDocumentStore.getState().dirty).toBe(false)
  })

  it('updates the tree word count of the document and its ancestors on save', async () => {
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await loaded('sc-2')
    useDocumentStore.getState().edit(para('one two three'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    saves[0]?.resolve(3)
    await settle()
    const tree = useTreeStore.getState()
    expect(tree.byId['sc-2']?.wordCount).toBe(3)
    expect(tree.wordCountRollup['sc-2']).toBe(3)
    expect(tree.wordCountRollup['ch-2']).toBe(3)
    expect(tree.wordCountRollup['arc-1']).toBe(1203)
    expect(tree.wordCountRollup.manuscript).toBe(4003)
    expect(tree.wordCountRollup['ch-1']).toBe(1200)
  })
})
