import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
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
}

/** An instance over plain strings whose reads and writes resolve only when the test says so. */
function instance(delayMs?: number): Instance {
  const gets: PendingGet[] = []
  const saves: PendingSave[] = []
  const saved: [string, number][] = []
  const store = createAutosaveStore<string, number>({
    empty: '',
    get: (id) => new Promise((resolve) => gets.push({ id, resolve })),
    save: (id, content) =>
      new Promise((resolve, reject) => saves.push({ id, content, resolve, reject })),
    onSaved: (id, result) => saved.push([id, result]),
    ...(delayMs === undefined ? {} : { delayMs })
  })
  return { store, gets, saves, saved }
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
})
