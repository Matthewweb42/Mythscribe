import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { RECOVERY_STASH_MS } from '@shared/recovery'
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
  /**
   * Reads the loaded records among `ids` again after main rewrote them behind the editor (find
   * and replace, F-10.2). Whatever is still pending for them is dropped, never written: it is a
   * draft of the text main just replaced, and saving it would silently undo the replacement.
   * Callers flush first, so nothing the author typed is in that draft. Each record goes back to
   * loading, so a mounted editor is rebuilt on the stored content. Ids that are not loaded are
   * ignored.
   */
  reload: (ids: readonly string[]) => Promise<void>
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
  /**
   * The crash-recovery journal (F-8.3): `stash` keeps the latest unsaved state of a record
   * outside the database a short while after an edit (`RECOVERY_STASH_MS`), and `clear` drops it
   * once a save landed with nothing newer pending. Failures are ignored: the real save reports
   * disk trouble.
   */
  journal?: {
    stash: (id: string, content: T) => Promise<unknown>
    clear: (id: string) => Promise<unknown>
  }
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
  delayMs = AUTOSAVE_DELAY_MS,
  journal
}: AutosaveConfig<T, R>): AutosaveStore<T> {
  /** The latest unsaved edit per record id; empty when everything is written. */
  const pending = new Map<string, SaveJob<T>>()
  /** The running debounce timer per record id. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The running recovery-stash throttle per record id (F-8.3). */
  const stashTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Ids with a journal entry this session, so a save that beat its stash sends no clear (F-8.3). */
  const stashed = new Set<string>()
  /** The token of the latest `load` per id, so a response from a superseded load is dropped. */
  const loadTokens = new Map<string, number>()
  let lastToken = 0
  /**
   * How many mounted views hold each record (F-11.1): the metadata pane and an outline row or
   * cork card can show the same node, so a record is read once on its first `load` and only
   * forgotten when its last holder unloads.
   */
  const holders = new Map<string, number>()
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

  function cancelStash(id: string): void {
    const timer = stashTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      stashTimers.delete(id)
    }
  }

  function cancelAllStashes(): void {
    for (const id of [...stashTimers.keys()]) cancelStash(id)
  }

  /** Starts the trailing stash throttle for `id` unless one is running (F-8.3). */
  function scheduleStash(id: string): void {
    if (!journal || stashTimers.has(id)) return
    stashTimers.set(
      id,
      setTimeout(() => {
        stashTimers.delete(id)
        const job = pending.get(id)
        if (!job) return
        stashed.add(id)
        journal.stash(id, job.content).catch(() => undefined)
      }, RECOVERY_STASH_MS)
    )
  }

  /** Drops the journal entry of `id` now that nothing of it is unsaved (F-8.3). */
  function clearJournal(id: string): void {
    cancelStash(id)
    if (!journal || !stashed.delete(id)) return
    journal.clear(id).catch(() => undefined)
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
      if (!pending.has(job.id)) {
        markClean(job.id)
        clearJournal(job.id)
      }
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
    for (const queued of [...pending.values()]) {
      if (!wanted(queued.id)) continue
      // Read the job again: while an earlier write was on the wire, a `reload` may have dropped
      // this one (F-10.2), or a newer edit replaced it.
      const job = pending.get(queued.id)
      if (job === undefined) continue
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

  /** Reads `id` from main into the store, without touching its holder count (`load` and `reload`). */
  async function fetchRecord(id: string): Promise<void> {
    const { flush } = useStore.getState()
    const set = useStore.setState
    const mine = ++lastToken
    loadTokens.set(id, mine)
    set((s) => ({ docs: { ...s.docs, [id]: { content: null, dirty: false } } }))
    // An editor that remounts right after its unload must read back its own last write, which
    // may still be queued behind another record's save. Failures are reported by the flush
    // that queued the job.
    if (pending.has(id)) {
      await flush().catch(() => undefined)
      if (loadTokens.get(id) !== mine) return
    }
    const stored = await read(id)
    if (loadTokens.get(id) !== mine) return // unloaded, cleared, or loaded again while in flight
    set((s) => ({ docs: { ...s.docs, [id]: { content: stored ?? empty, dirty: false } } }))
  }

  const useStore = create<AutosaveState<T>>((set, get) => ({
    docs: {},

    async load(id) {
      unregister ??= registerPendingSave(() => get().flush())
      const held = holders.get(id) ?? 0
      holders.set(id, held + 1)
      // Already held: the first holder's read (finished or in flight) serves this one too.
      if (held > 0 && id in get().docs) return
      await fetchRecord(id)
    },

    async reload(ids) {
      // Drop the drafts first, synchronously: a flush that is writing another record resumes
      // before this function does, and must not find them still queued (`drain` reads the job
      // again). Callers flush before main rewrites, so nothing of these should be on the wire;
      // if a write is, wait for it, so the read below shows what is really stored.
      const loaded = ids.filter((id) => id in get().docs)
      for (const id of loaded) {
        cancelTimer(id)
        pending.delete(id)
        // The draft is unwanted (it predates main's rewrite), so its journal entry is too.
        clearJournal(id)
      }
      while (inflight !== null) await inflight.catch(() => undefined)
      await Promise.all(loaded.map((id) => fetchRecord(id)))
    },

    unload(id) {
      const held = holders.get(id) ?? 0
      if (held > 1) {
        holders.set(id, held - 1)
        return
      }
      holders.delete(id)
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
      scheduleStash(id)
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
      // The flush's saves clear their own journal entries; a failed one keeps its entry.
      cancelAllStashes()
      get().flush().catch(reportFailure)
      unregister?.()
      unregister = null
      loadTokens.clear()
      holders.clear()
      set({ docs: {} })
    }
  }))

  function reset(): void {
    cancelAllTimers()
    cancelAllStashes()
    stashed.clear()
    pending.clear()
    inflight = null
    unregister?.()
    unregister = null
    loadTokens.clear()
    holders.clear()
    useStore.setState({ docs: {} })
  }

  return { useStore, reset }
}
