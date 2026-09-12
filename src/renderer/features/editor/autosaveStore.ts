import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'

/** How long after the last edit the debounced save fires (F-3.2). */
export const AUTOSAVE_DELAY_MS = 1000

/** One loaded record. */
export interface LoadedRecord<T> {
  /**
   * The latest value: null until `get` resolves (a never-written record loads as `empty`), then
   * every edit as the editor reports it, so an editor rebuilt mid-session (a scene-break
   * change, F-3.6) starts from the author's latest text, never from the load.
   */
  content: T | null
  /** True once the editor has changed the record since it loaded and the change is not yet saved. */
  dirty: boolean
}

/**
 * The store an autosave instance exposes. Several records are loaded at once in the stacked
 * view (F-3.8), each keyed by node id: an editor loads its id on mount and unloads it on
 * unmount, and every edit lands here under its own id and is written through `save` after a
 * per-record debounce, on Ctrl+S (`saveNow`), when its editor unmounts (`unload`), and when
 * the project closes (via the pending-save registry). Only a successful save clears `dirty`.
 */
export interface AutosaveState<T> {
  /** Every loaded record by node id; an entry appears as soon as `load` starts so the pane can tell loading from empty. */
  docs: Record<string, LoadedRecord<T>>
  /** Loads `id` (waiting first for a pending save of the same id, so a remount reads its own last write). */
  load: (id: string) => Promise<void>
  /** Saves any pending edit to `id` at once (without waiting), then forgets the record. */
  unload: (id: string) => void
  /** Records the latest editor state of `id` (on the record and as the pending save) and (re)starts its debounce timer. Ignored for ids that are not loaded. */
  edit: (id: string, content: T) => void
  /**
   * Writes every pending edit (one job per record, so a failed save for one record survives
   * edits to another). Every job is attempted; the first failure is rethrown afterwards and its
   * job kept for the next attempt unless a newer edit to that record replaced it.
   */
  flush: () => Promise<void>
  /** Ctrl+S: flush now and toast on failure. */
  saveNow: () => Promise<void>
  /** Flushes every pending save (without waiting), unregisters from the registry, and empties the store. */
  clear: () => void
}

export interface AutosaveConfig<T, R> {
  /** What a never-written record loads as. */
  empty: T
  /** Reads the stored value; null when nothing was written yet. */
  get: (id: string) => Promise<T | null>
  /** Writes one record. */
  save: (id: string, content: T) => Promise<R>
  /** Runs after each successful save with what `save` returned (e.g. the cached word count). */
  onSaved?: (id: string, result: R) => void
  /** The debounce; `AUTOSAVE_DELAY_MS` unless a test shortens it. */
  delayMs?: number
}

export interface AutosaveStore<T> {
  useStore: UseBoundStore<StoreApi<AutosaveState<T>>>
  /** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
  reset: () => void
}

interface SaveJob<T> {
  id: string
  content: T
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

/**
 * Builds one autosave store (F-3.2): the document store and the notes store (F-3.7) are two
 * instances. The pending jobs, timers, load tokens, in-flight write, and registry subscription
 * live in this closure, per instance, so an unmounting editor can never orphan a save and one
 * instance's failure never blocks the other's flush. Each instance registers its own flusher
 * with the pending-save registry on first load and unregisters on `clear` and `reset`.
 */
export function createAutosaveStore<T, R>({
  empty,
  get: read,
  save,
  onSaved,
  delayMs = AUTOSAVE_DELAY_MS
}: AutosaveConfig<T, R>): AutosaveStore<T> {
  /** The latest unsaved edit per record id; empty when everything is written. */
  const pending = new Map<string, SaveJob<T>>()
  /** The running debounce timer per record id. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The token of the latest `load` per id, so a response from a superseded load is dropped. */
  const loadTokens = new Map<string, number>()
  let lastToken = 0
  /** The write currently on the wire, so every flush (and the close/quit path) waits for it. */
  let inflight: Promise<void> | null = null
  /** Removes this store's flusher from the pending-save registry; null while nothing is registered. */
  let unregister: (() => void) | null = null

  function cancelTimer(id: string): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  function cancelAllTimers(): void {
    for (const id of [...timers.keys()]) cancelTimer(id)
  }

  /** Clears `dirty` on a record that is still loaded; a no-op for anything else. */
  function markClean(id: string): void {
    useStore.setState((s) => {
      const doc = s.docs[id]
      if (!doc?.dirty) return {}
      return { docs: { ...s.docs, [id]: { ...doc, dirty: false } } }
    })
  }

  async function write(job: SaveJob<T>): Promise<void> {
    try {
      const result = await save(job.id, job.content)
      onSaved?.(job.id, result)
      if (!pending.has(job.id)) markClean(job.id)
    } catch (err) {
      if (!pending.has(job.id)) pending.set(job.id, job) // keep it for the next attempt; a newer edit wins
      throw err
    }
  }

  /**
   * Writes the pending jobs that `wanted` selects, in queue order. Writes are serialized: wait
   * for the one on the wire (its own caller reports its failure) so a close or quit cannot
   * outrun a save that already left, and an older write never lands last. Every selected job is
   * attempted; the first failure is rethrown at the end.
   */
  async function drain(wanted: (id: string) => boolean): Promise<void> {
    while (inflight !== null) await inflight.catch(() => undefined)
    let failure: { err: unknown } | null = null
    for (const job of [...pending.values()]) {
      if (!wanted(job.id)) continue
      pending.delete(job.id)
      inflight = write(job)
      try {
        await inflight
      } catch (err) {
        failure ??= { err }
      } finally {
        inflight = null
      }
    }
    if (failure) throw failure.err
  }

  const useStore = create<AutosaveState<T>>((set, get) => ({
    docs: {},

    async load(id) {
      unregister ??= registerPendingSave(() => get().flush())
      const mine = ++lastToken
      loadTokens.set(id, mine)
      set((s) => ({ docs: { ...s.docs, [id]: { content: null, dirty: false } } }))
      // An editor that remounts right after its unload must read back its own last write, which
      // may still be queued behind another record's save. Failures are reported by the flush
      // that queued the job.
      if (pending.has(id)) {
        await get()
          .flush()
          .catch(() => undefined)
        if (loadTokens.get(id) !== mine) return
      }
      const stored = await read(id)
      if (loadTokens.get(id) !== mine) return // unloaded, cleared, or loaded again while in flight
      set((s) => ({ docs: { ...s.docs, [id]: { content: stored ?? empty, dirty: false } } }))
    },

    unload(id) {
      cancelTimer(id)
      loadTokens.delete(id)
      if (pending.has(id)) drain((jobId) => jobId === id).catch(reportFailure)
      set((s) => {
        if (!(id in s.docs)) return {}
        const docs = { ...s.docs }
        delete docs[id]
        return { docs }
      })
    },

    edit(id, content) {
      const doc = get().docs[id]
      if (!doc) return
      pending.set(id, { id, content })
      set((s) => ({ docs: { ...s.docs, [id]: { content, dirty: true } } }))
      cancelTimer(id)
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          drain((jobId) => jobId === id).catch(reportFailure)
        }, delayMs)
      )
    },

    async flush() {
      cancelAllTimers()
      await drain(() => true)
    },

    async saveNow() {
      try {
        await get().flush()
      } catch (err) {
        reportFailure(err)
      }
    },

    clear() {
      get().flush().catch(reportFailure)
      unregister?.()
      unregister = null
      loadTokens.clear()
      set({ docs: {} })
    }
  }))

  function reset(): void {
    cancelAllTimers()
    pending.clear()
    inflight = null
    unregister?.()
    unregister = null
    loadTokens.clear()
    useStore.setState({ docs: {} })
  }

  return { useStore, reset }
}
