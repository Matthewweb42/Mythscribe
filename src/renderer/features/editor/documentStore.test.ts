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

const store = (): ReturnType<typeof useDocumentStore.getState> => useDocumentStore.getState()
const doc = (id: string): { content: TiptapNodeT | null; dirty: boolean } | undefined =>
  store().docs[id]
const dirty = (id: string): boolean | undefined => doc(id)?.dirty
const edit = (id: string, text: string): void => store().edit(id, para(text))

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
  it('adds the id at once and the content when document:get resolves', async () => {
    const loading = store().load('scene-1')
    expect(doc('scene-1')).toEqual({ content: null, dirty: false })
    gets[0]?.resolve(hello)
    await loading
    expect(doc('scene-1')).toEqual({ content: hello, dirty: false })
  })

  it('loads a never-written document as the empty document', async () => {
    await loaded('scene-1', null)
    expect(doc('scene-1')?.content).toEqual(EMPTY_DOC)
  })

  it('holds several documents at once, each resolved on its own (F-3.8)', async () => {
    const first = store().load('scene-1')
    const second = store().load('scene-2')
    expect(Object.keys(store().docs)).toEqual(['scene-1', 'scene-2'])
    expect(gets.map((g) => g.id)).toEqual(['scene-1', 'scene-2'])
    gets[1]?.resolve(para('Second'))
    await second
    expect(doc('scene-1')).toEqual({ content: null, dirty: false })
    expect(doc('scene-2')).toEqual({ content: para('Second'), dirty: false })
    gets[0]?.resolve(hello)
    await first
    expect(doc('scene-1')).toEqual({ content: hello, dirty: false })
  })

  it('drops a response from a superseded load of the same id', async () => {
    const first = store().load('scene-1')
    const second = store().load('scene-1')
    gets[1]?.resolve(hello)
    await second
    gets[0]?.resolve(EMPTY_DOC)
    await first
    expect(doc('scene-1')).toEqual({ content: hello, dirty: false })
  })

  it('drops a response that arrives after clear()', async () => {
    const loading = store().load('scene-1')
    store().clear()
    gets[0]?.resolve(hello)
    await loading
    expect(store().docs).toEqual({})
  })

  it('drops a response that arrives after unload()', async () => {
    const loading = store().load('scene-1')
    store().unload('scene-1')
    expect(store().docs).toEqual({})
    gets[0]?.resolve(hello)
    await loading
    expect(store().docs).toEqual({})
  })

  it('resets dirty on load and clear, and propagates load errors', async () => {
    await loaded('scene-1')
    edit('scene-1', 'x')
    expect(dirty('scene-1')).toBe(true)
    const loading = store().load('scene-2')
    expect(dirty('scene-2')).toBe(false)
    expect(dirty('scene-1')).toBe(true)
    gets[1]?.reject(new Error('Database is locked'))
    await expect(loading).rejects.toThrow('Database is locked')
    edit('scene-1', 'y')
    store().clear()
    expect(store().docs).toEqual({})
  })
})

describe('useDocumentStore autosave (F-3.2)', () => {
  it('edit marks dirty and saves the latest content after the debounce, then clears dirty', async () => {
    await loaded('scene-1')
    edit('scene-1', 'Hello w')
    expect(dirty('scene-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('Hello w')]])
    expect(dirty('scene-1')).toBe(true)
    saves[0]?.resolve(2)
    await settle()
    expect(dirty('scene-1')).toBe(false)
  })

  it('keeps the latest content on the record, so a rebuilt editor starts from it (F-3.6)', async () => {
    await loaded('scene-1')
    expect(doc('scene-1')?.content).toEqual(hello)
    edit('scene-1', 'Hello w')
    expect(doc('scene-1')).toEqual({ content: para('Hello w'), dirty: true })
    edit('scene-1', 'Hello wo')
    expect(doc('scene-1')?.content).toEqual(para('Hello wo'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    saves[0]?.resolve(2)
    await settle()
    expect(doc('scene-1')).toEqual({ content: para('Hello wo'), dirty: false })
  })

  it('coalesces edits within the debounce window into one save with the latest content', async () => {
    await loaded('scene-1')
    edit('scene-1', 'a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100)
    edit('scene-1', 'ab')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100)
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(saves.map((s) => s.content)).toEqual([para('ab')])
  })

  it('ignores edits to an id that is not loaded', async () => {
    edit('scene-1', 'lost')
    expect(store().docs).toEqual({})
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(0)
  })

  it('debounces each document on its own: one timer firing does not flush the other (F-3.8)', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    edit('scene-1', 'A')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2)
    edit('scene-2', 'B')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2)
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('A')]])
    expect(dirty('scene-2')).toBe(true)
    saves[0]?.resolve(1)
    await settle()
    expect(dirty('scene-1')).toBe(false)
    expect(dirty('scene-2')).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2)
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-2'])
    saves[1]?.resolve(1)
    await settle()
    expect(dirty('scene-2')).toBe(false)
  })

  it('saveNow saves immediately and cancels the debounce timer', async () => {
    await loaded('scene-1')
    edit('scene-1', 'now')
    const saving = store().saveNow()
    expect(saves.map((s) => s.content)).toEqual([para('now')])
    saves[0]?.resolve(1)
    await saving
    expect(dirty('scene-1')).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(1)
  })

  it('saveNow writes every pending document at once (Ctrl+S in a stacked region)', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    edit('scene-1', 'A')
    edit('scene-2', 'B')
    const saving = store().saveNow()
    await settle()
    expect(saves.map((s) => s.id)).toEqual(['scene-1'])
    saves[0]?.resolve(1)
    await settle()
    expect(saves.map((s) => [s.id, s.content])).toEqual([
      ['scene-1', para('A')],
      ['scene-2', para('B')]
    ])
    saves[1]?.resolve(1)
    await saving
    expect(dirty('scene-1')).toBe(false)
    expect(dirty('scene-2')).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(2)
  })

  it('saveNow and the timer do nothing when there is nothing pending', async () => {
    await loaded('scene-1')
    await store().saveNow()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(0)
  })

  it('a failed save toasts, keeps dirty, and retries the same job on the next saveNow', async () => {
    await loaded('scene-1')
    edit('scene-1', 'keep me')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    saves[0]?.reject(new Error('Database is locked'))
    await settle()
    expect(toasts()).toEqual(['Database is locked'])
    expect(dirty('scene-1')).toBe(true)

    const retry = store().saveNow()
    expect(saves.map((s) => s.content)).toEqual([para('keep me'), para('keep me')])
    saves[1]?.resolve(2)
    await retry
    expect(dirty('scene-1')).toBe(false)
    expect(toasts()).toEqual(['Database is locked'])
  })

  it('a newer edit made during a failing save wins over the failed job', async () => {
    await loaded('scene-1')
    edit('scene-1', 'old')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    edit('scene-1', 'new')
    saves[0]?.reject(new Error('boom'))
    await settle()
    expect(toasts()).toEqual(['boom'])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves.map((s) => s.content)).toEqual([para('old'), para('new')])
    saves[1]?.resolve(1)
    await settle()
    expect(dirty('scene-1')).toBe(false)
  })

  it('stays dirty when an edit lands while a save is in flight', async () => {
    await loaded('scene-1')
    edit('scene-1', 'one')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    edit('scene-1', 'two')
    saves[0]?.resolve(1)
    await settle()
    expect(dirty('scene-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves.map((s) => s.content)).toEqual([para('one'), para('two')])
    saves[1]?.resolve(1)
    await settle()
    expect(dirty('scene-1')).toBe(false)
  })

  it('unload saves the pending edit under its id at once, without waiting, and forgets the document', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    edit('scene-1', 'unsaved')
    edit('scene-2', 'other')
    store().unload('scene-1')
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('unsaved')]])
    expect(Object.keys(store().docs)).toEqual(['scene-2'])
    expect(dirty('scene-2')).toBe(true)
    // The old save resolving later does not touch the other document's dirty flag, and the
    // other document's own debounce still runs.
    saves[0]?.resolve(1)
    await settle()
    expect(dirty('scene-2')).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves[1]).toMatchObject({ id: 'scene-2', content: para('other') })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(saves).toHaveLength(2)
  })

  it('unload of a clean document sends nothing and is a no-op for unknown ids', async () => {
    await loaded('scene-1')
    store().unload('scene-1')
    store().unload('never-loaded')
    expect(saves).toHaveLength(0)
    expect(store().docs).toEqual({})
  })

  it('a failed save during unload toasts', async () => {
    await loaded('scene-1')
    edit('scene-1', 'unsaved')
    store().unload('scene-1')
    saves[0]?.reject(new Error('disk full'))
    await settle()
    expect(toasts()).toEqual(['disk full'])
    expect(store().docs).toEqual({})
    // The edit is kept for the next flush rather than lost with the region.
    const flushing = flushPendingSaves()
    expect(saves.map((s) => [s.id, s.content])).toEqual([
      ['scene-1', para('unsaved')],
      ['scene-1', para('unsaved')]
    ])
    saves[1]?.resolve(1)
    await flushing
  })

  it('reloading an id right after its unload waits for that save before reading it back', async () => {
    await loaded('scene-1')
    edit('scene-1', 'A-edit')
    const saving = store().saveNow() // scene-1's write is now on the wire
    edit('scene-1', 'A-edit-2') // queued behind it
    store().unload('scene-1') // its drain waits on the wire
    const loading = store().load('scene-1') // a remount (e.g. StrictMode, or folder → document)
    expect(doc('scene-1')).toEqual({ content: null, dirty: false })
    await settle()
    expect(gets.map((g) => g.id)).toEqual(['scene-1']) // no second get yet
    saves[0]?.resolve(1)
    await saving
    await settle()
    expect(saves.map((s) => s.content)).toEqual([para('A-edit'), para('A-edit-2')])
    saves[1]?.resolve(1)
    await settle()
    expect(gets.map((g) => g.id)).toEqual(['scene-1', 'scene-1'])
    gets[1]?.resolve(para('A-edit-2'))
    await loading
    expect(doc('scene-1')).toEqual({ content: para('A-edit-2'), dirty: false })
  })

  it('flushPendingSaves runs the flush after a load and no longer after clear()', async () => {
    await flushPendingSaves()
    expect(saves).toHaveLength(0)

    await loaded('scene-1')
    edit('scene-1', 'pending')
    const flushing = flushPendingSaves()
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('pending')]])
    saves[0]?.resolve(1)
    await flushing
    expect(dirty('scene-1')).toBe(false)

    edit('scene-1', 'failing')
    const failing = flushPendingSaves()
    saves[1]?.reject(new Error('locked'))
    await expect(failing).rejects.toThrow('locked')
    expect(dirty('scene-1')).toBe(true)

    store().clear()
    expect(saves).toHaveLength(3) // clear() flushed the retried job
    saves[2]?.resolve(1)
    await settle()
    await flushPendingSaves()
    expect(saves).toHaveLength(3)
  })

  it('flushPendingSaves waits for a debounced save that is already on the wire', async () => {
    await loaded('scene-1')
    edit('scene-1', 'typed')
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
    expect(dirty('scene-1')).toBe(false)
  })

  it('flush attempts every pending document and rethrows the first failure, keeping its job', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    await loaded('scene-3')
    edit('scene-1', 'A')
    edit('scene-2', 'B')
    edit('scene-3', 'C')
    const flushing = flushPendingSaves()
    saves[0]?.reject(new Error('A failed'))
    await settle()
    saves[1]?.resolve(1)
    await settle()
    saves[2]?.resolve(1)
    await expect(flushing).rejects.toThrow('A failed')
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-2', 'scene-3'])
    expect(dirty('scene-1')).toBe(true)
    expect(dirty('scene-2')).toBe(false)
    expect(dirty('scene-3')).toBe(false)
    // Only the failed job is retried.
    const retry = store().saveNow()
    expect(saves.slice(3).map((s) => [s.id, s.content])).toEqual([['scene-1', para('A')]])
    saves[3]?.resolve(1)
    await retry
    expect(dirty('scene-1')).toBe(false)
  })

  it('serializes a later edit behind a save that is in flight', async () => {
    await loaded('scene-1')
    edit('scene-1', 'first')
    const first = store().saveNow()
    edit('scene-1', 'second')
    const second = store().saveNow()
    await settle()
    expect(saves).toHaveLength(1) // the second write waits for the first
    saves[0]?.resolve(1)
    await first
    await settle()
    expect(saves.map((s) => s.content)).toEqual([para('first'), para('second')])
    saves[1]?.resolve(1)
    await second
    expect(dirty('scene-1')).toBe(false)
  })

  it('clear() flushes every pending edit and drops the registration once', async () => {
    await loaded('scene-1')
    await loaded('scene-2')
    edit('scene-1', 'first words')
    edit('scene-2', 'last words')
    store().clear()
    expect(saves.map((s) => [s.id, s.content])).toEqual([['scene-1', para('first words')]])
    expect(store().docs).toEqual({})
    saves[0]?.resolve(2)
    await settle()
    expect(saves.map((s) => [s.id, s.content])).toEqual([
      ['scene-1', para('first words')],
      ['scene-2', para('last words')]
    ])
    saves[1]?.resolve(2)
    await settle()
    await flushPendingSaves()
    expect(saves).toHaveLength(2)
  })

  it('a failed save for another document leaves the current one dirty until both are written', async () => {
    await loaded('scene-1')
    edit('scene-1', 'A-edit')
    store().unload('scene-1') // flushes scene-1 without waiting
    await loaded('scene-2')
    saves[0]?.reject(new Error('locked'))
    await settle()
    edit('scene-2', 'B-edit')
    const saving = store().saveNow()
    await settle()
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-1'])
    saves[1]?.resolve(1)
    await settle()
    saves[2]?.resolve(1)
    await saving
    expect(saves.map((s) => s.id)).toEqual(['scene-1', 'scene-1', 'scene-2'])
    expect(dirty('scene-2')).toBe(false)
  })

  it('updates the tree word count of the document and its ancestors on save', async () => {
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await loaded('sc-2')
    edit('sc-2', 'one two three')
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
