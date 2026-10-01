import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { createAutosaveStore, type AutosaveStore } from './autosaveStore'
import { resetDocumentStore } from './documentStore'
import { resetNotesStore } from './notesStore'

/**
 * F-10.2 verification: `reload` promises that a draft still pending for a rewritten record is
 * "dropped, never written". These cases put a flush on the wire while `reload` runs.
 */
interface PendingSave {
  id: string
  content: string
  resolve: (result: number) => void
}

let store: AutosaveStore<string>
let gets: { id: string; resolve: (value: string | null) => void }[]
let saves: PendingSave[]

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

async function loaded(id: string): Promise<void> {
  const loading = store.useStore.getState().load(id)
  gets[gets.length - 1]?.resolve('stored')
  await loading
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDocumentStore()
  resetNotesStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(null)
  gets = []
  saves = []
  store = createAutosaveStore<string, number>({
    empty: '',
    get: (id) => new Promise((resolve) => gets.push({ id, resolve })),
    save: (id, content) => new Promise((resolve) => saves.push({ id, content, resolve }))
  })
})
afterEach(() => {
  store.reset()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('autosave reload under a running flush (F-10.2)', () => {
  it('does not write the stale draft of a reloaded record that a running flush had queued', async () => {
    await loaded('n1')
    await loaded('n2')
    store.useStore.getState().edit('n1', 'first')
    store.useStore.getState().edit('n2', 'stale draft of the text main replaced')
    // A flush is writing n1; n2 is next in its queue.
    const flushing = store.useStore.getState().flush()
    await settle()
    expect(saves.map((save) => save.id)).toEqual(['n1'])

    // Main rewrote n2 meanwhile, and the renderer reads it again.
    const reloading = store.useStore.getState().reload(['n2'])
    await settle()
    saves[0]?.resolve(1)
    await settle()
    // Let whatever was queued go out, then answer the read.
    saves.slice(1).forEach((save) => save.resolve(1))
    await settle()
    gets[gets.length - 1]?.resolve('rewritten by main')
    await flushing
    await reloading

    expect(saves.map((save) => [save.id, save.content])).toEqual([['n1', 'first']])
  })

  it('leaves another record alone: its draft stays pending and dirty, and is still saved', async () => {
    await loaded('n1')
    await loaded('n2')
    store.useStore.getState().edit('n2', 'the author is still typing here')
    const reloading = store.useStore.getState().reload(['n1'])
    await settle()
    gets[gets.length - 1]?.resolve('rewritten by main')
    await reloading
    expect(store.useStore.getState().docs.n2).toEqual({
      content: 'the author is still typing here',
      dirty: true
    })
    const flushing = store.useStore.getState().flush()
    await settle()
    expect(saves.map((save) => [save.id, save.content])).toEqual([
      ['n2', 'the author is still typing here']
    ])
    saves[0]?.resolve(1)
    await flushing
  })
})
