import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { RECOVERY_STASH_MS } from '@shared/recovery'
import { AUTOSAVE_DELAY_MS, createAutosaveStore, type AutosaveStore } from './autosaveStore'
import { resetDocumentStore } from './documentStore'
import { resetNotesStore } from './notesStore'

interface PendingGet {
  id: string
  resolve: (value: string | null) => void
}

interface PendingSave {
  id: string
  content: string
  resolve: (result: number) => void
  reject: (err: Error) => void
}

interface Instance {
  store: AutosaveStore<string>
  gets: PendingGet[]
  saves: PendingSave[]
  saved: [string, number][]
  /** The recovery journal calls (F-8.3), in order: `['stash', id, content]` or `['clear', id]`. */
  journal: string[][]
}

/** An instance over plain strings whose reads and writes resolve only when the test says so. */
function instance(delayMs?: number): Instance {
  const gets: PendingGet[] = []
  const saves: PendingSave[] = []
  const saved: [string, number][] = []
  const journal: string[][] = []
  const store = createAutosaveStore<string, number>({
    empty: '',
    get: (id) => new Promise((resolve) => gets.push({ id, resolve })),
    save: (id, content) =>
      new Promise((resolve, reject) => saves.push({ id, content, resolve, reject })),
    onSaved: (id, result) => saved.push([id, result]),
    journal: {
      stash: (id, content) => {
        journal.push(['stash', id, content])
        return Promise.resolve()
      },
      clear: (id) => {
        journal.push(['clear', id])
        return Promise.resolve()
      }
    },
    ...(delayMs === undefined ? {} : { delayMs })
  })
  return { store, gets, saves, saved, journal }
}

/** Loads `id` on `inst` and resolves its read with `value`. */
async function loaded(inst: Instance, id: string, value: string | null = 'stored'): Promise<void> {
  const loading = inst.store.useStore.getState().load(id)
  inst.gets[inst.gets.length - 1]?.resolve(value)
  await loading
}

const dirty = (inst: Instance, id: string): boolean | undefined =>
  inst.store.useStore.getState().docs[id]?.dirty

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

let a: Instance
let b: Instance

beforeEach(() => {
  vi.useFakeTimers()
  resetDocumentStore()
  resetNotesStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(null)
  a = instance()
  b = instance()
})
afterEach(() => {
  a.store.reset()
  b.store.reset()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('createAutosaveStore', () => {
  it('keeps two instances independent: records, timers, and pending jobs', async () => {
    await loaded(a, 'n1', 'A')
    await loaded(b, 'n1', 'B')
    expect(a.store.useStore.getState().docs.n1).toEqual({ content: 'A', dirty: false })
    expect(b.store.useStore.getState().docs.n1).toEqual({ content: 'B', dirty: false })
    a.store.useStore.getState().edit('n1', 'A2')
    expect(dirty(a, 'n1')).toBe(true)
    expect(dirty(b, 'n1')).toBe(false)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(a.saves.map((s) => [s.id, s.content])).toEqual([['n1', 'A2']])
    expect(b.saves).toHaveLength(0)
    a.store.useStore.getState().unload('n1')
    expect(b.store.useStore.getState().docs.n1).toEqual({ content: 'B', dirty: false })
  })

  it('reads a record once for two holders and forgets it only when the last one unloads (F-11.1)', async () => {
    await loaded(a, 'n1', 'A')
    await a.store.useStore.getState().load('n1')
    expect(a.gets).toHaveLength(1)
    a.store.useStore.getState().edit('n1', 'A2')
    a.store.useStore.getState().unload('n1')
    expect(a.store.useStore.getState().docs.n1).toEqual({ content: 'A2', dirty: true })
    a.store.useStore.getState().unload('n1')
    expect(a.store.useStore.getState().docs.n1).toBeUndefined()
    await settle()
    expect(a.saves.map((s) => [s.id, s.content])).toEqual([['n1', 'A2']])
    // Held again from zero, it is read again.
    await loaded(a, 'n1', 'A2')
    expect(a.gets).toHaveLength(2)
  })

  it('reload reads a held record again without adding a holder', async () => {
    await loaded(a, 'n1', 'A')
    const reloading = a.store.useStore.getState().reload(['n1'])
    await settle()
    a.gets[a.gets.length - 1]?.resolve('B')
    await reloading
    a.store.useStore.getState().unload('n1')
    expect(a.store.useStore.getState().docs.n1).toBeUndefined()
  })

  it('a never-written record loads as `empty`', async () => {
    await loaded(a, 'n1', null)
    expect(a.store.useStore.getState().docs.n1).toEqual({ content: '', dirty: false })
  })

  it('honours a custom debounce', async () => {
    const quick = instance(50)
    await loaded(quick, 'n1')
    quick.store.useStore.getState().edit('n1', 'x')
    await vi.advanceTimersByTimeAsync(49)
    expect(quick.saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(quick.saves).toHaveLength(1)
    quick.store.reset()
  })

  it('flushPendingSaves writes a pending document save and a pending notes save for the same id, each with its own content, and a failure in one does not block the other', async () => {
    await loaded(a, 'n1')
    await loaded(b, 'n1')
    a.store.useStore.getState().edit('n1', 'document text')
    b.store.useStore.getState().edit('n1', 'notes text')
    const flushing = flushPendingSaves()
    await settle()
    // Both instances put their write on the wire at once; neither waits for the other.
    expect(a.saves.map((s) => [s.id, s.content])).toEqual([['n1', 'document text']])
    expect(b.saves.map((s) => [s.id, s.content])).toEqual([['n1', 'notes text']])
    a.saves[0]?.reject(new Error('document locked'))
    b.saves[0]?.resolve(7)
    await expect(flushing).rejects.toThrow('document locked')
    expect(dirty(a, 'n1')).toBe(true)
    expect(dirty(b, 'n1')).toBe(false)
    // Only the failed instance retries its job.
    const retry = flushPendingSaves()
    await settle()
    expect(a.saves).toHaveLength(2)
    expect(b.saves).toHaveLength(1)
    a.saves[1]?.resolve(3)
    await retry
    expect(dirty(a, 'n1')).toBe(false)
  })

  it('calls onSaved with the save result only on success', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'first')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    a.saves[0]?.reject(new Error('boom'))
    await settle()
    expect(a.saved).toEqual([])
    expect(toasts()).toEqual(['boom'])
    const retry = a.store.useStore.getState().saveNow()
    a.saves[1]?.resolve(5)
    await retry
    expect(a.saved).toEqual([['n1', 5]])
  })

  it('reset cancels the debounce timer, drops pending jobs, and unregisters from the registry', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'lost on reset')
    a.store.reset()
    expect(a.store.useStore.getState().docs).toEqual({})
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(a.saves).toHaveLength(0)
    await flushPendingSaves()
    expect(a.saves).toHaveLength(0)
    // The instance is usable again afterwards and registers anew on its next load.
    await loaded(a, 'n2')
    a.store.useStore.getState().edit('n2', 'after reset')
    const flushing = flushPendingSaves()
    expect(a.saves.map((s) => [s.id, s.content])).toEqual([['n2', 'after reset']])
    a.saves[0]?.resolve(1)
    await flushing
  })

  it('clear unregisters this instance only; the other keeps flushing through the registry', async () => {
    await loaded(a, 'n1')
    await loaded(b, 'n1')
    a.store.useStore.getState().clear()
    b.store.useStore.getState().edit('n1', 'still here')
    const flushing = flushPendingSaves()
    expect(a.saves).toHaveLength(0)
    expect(b.saves.map((s) => s.content)).toEqual(['still here'])
    b.saves[0]?.resolve(1)
    await flushing
  })

  it('reload reads the loaded records again and drops their pending drafts unsaved (F-10.2)', async () => {
    await loaded(a, 'n1')
    await loaded(a, 'n2')
    a.store.useStore.getState().edit('n1', 'a stale draft')
    a.store.useStore.getState().edit('n2', 'kept')
    const reloading = a.store.useStore.getState().reload(['n1', 'not-loaded'])
    await settle()
    // Back to loading, which is what rebuilds a mounted editor; only the loaded id is read.
    expect(a.store.useStore.getState().docs.n1).toEqual({ content: null, dirty: false })
    expect(a.gets.slice(2).map((get) => get.id)).toEqual(['n1'])
    a.gets[2]?.resolve('rewritten by main')
    await reloading
    expect(a.store.useStore.getState().docs.n1).toEqual({
      content: 'rewritten by main',
      dirty: false
    })
    // The stale draft is never written, by the timer or by a flush; the other record's is.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(a.saves.map((save) => [save.id, save.content])).toEqual([['n2', 'kept']])
    a.saves[0]?.resolve(1)
    await settle()
    await flushPendingSaves()
    expect(a.saves).toHaveLength(1)
  })

  it('reload waits for a write already on the wire before it reads', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'on the wire')
    const flushing = a.store.useStore.getState().flush()
    await settle()
    expect(a.saves).toHaveLength(1)
    const reloading = a.store.useStore.getState().reload(['n1'])
    await settle()
    expect(a.gets).toHaveLength(1)
    a.saves[0]?.resolve(1)
    await flushing
    await settle()
    expect(a.gets).toHaveLength(2)
    a.gets[1]?.resolve('as stored')
    await reloading
    expect(a.store.useStore.getState().docs.n1).toEqual({ content: 'as stored', dirty: false })
  })
})

describe('createAutosaveStore recovery journal (F-8.3)', () => {
  it('stashes the latest content once the throttle runs out, then clears after the save', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'one')
    await vi.advanceTimersByTimeAsync(RECOVERY_STASH_MS - 1)
    a.store.useStore.getState().edit('n1', 'one two') // does not restart the throttle
    expect(a.journal).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(a.journal).toEqual([['stash', 'n1', 'one two']])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    a.saves[0]?.resolve(2)
    await settle()
    expect(a.journal).toEqual([
      ['stash', 'n1', 'one two'],
      ['clear', 'n1']
    ])
  })

  it('keeps the entry while a newer edit is pending when a save lands', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'first')
    const flushing = a.store.useStore.getState().flush()
    await settle()
    a.store.useStore.getState().edit('n1', 'newer')
    a.saves[0]?.resolve(1)
    await flushing
    expect(a.journal).toEqual([])
    await vi.advanceTimersByTimeAsync(RECOVERY_STASH_MS)
    expect(a.journal).toEqual([['stash', 'n1', 'newer']])
  })

  it('neither stashes nor clears when the save beat the throttle, and keeps the entry after a failed save', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'quick')
    const flushing = a.store.useStore.getState().flush()
    a.saves[0]?.resolve(1)
    await flushing
    await vi.advanceTimersByTimeAsync(RECOVERY_STASH_MS)
    expect(a.journal).toEqual([])

    a.store.useStore.getState().edit('n1', 'doomed')
    await vi.advanceTimersByTimeAsync(RECOVERY_STASH_MS)
    const failing = a.store.useStore.getState().flush()
    a.saves[1]?.reject(new Error('disk full'))
    await expect(failing).rejects.toThrow('disk full')
    expect(a.journal).toEqual([['stash', 'n1', 'doomed']])
  })

  it('reload clears the journal of the dropped drafts', async () => {
    await loaded(a, 'n1')
    a.store.useStore.getState().edit('n1', 'a stale draft')
    await vi.advanceTimersByTimeAsync(RECOVERY_STASH_MS)
    const reloading = a.store.useStore.getState().reload(['n1'])
    a.gets[1]?.resolve('rewritten by main')
    await reloading
    expect(a.journal).toEqual([
      ['stash', 'n1', 'a stale draft'],
      ['clear', 'n1']
    ])
  })

  it('swallows journal failures', async () => {
    const failing = createAutosaveStore<string, number>({
      empty: '',
      get: () => Promise.resolve('stored'),
      save: () => Promise.resolve(1),
      journal: {
        stash: () => Promise.reject(new Error('no disk')),
        clear: () => Promise.reject(new Error('no disk'))
      }
    })
    await failing.useStore.getState().load('n1')
    failing.useStore.getState().edit('n1', 'x')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(toasts()).toEqual([])
    expect(failing.useStore.getState().docs.n1?.dirty).toBe(false)
    failing.reset()
  })
})
