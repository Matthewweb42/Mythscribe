import { create } from 'zustand'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long after the last edit the debounced save fires (F-3.2). */
export const AUTOSAVE_DELAY_MS = 1000

/** One loaded document (F-3.1). */
export interface LoadedDocument {
  /** The document as loaded; null until `document:get` resolves. A never-written node loads as `EMPTY_DOC`. */
  content: TiptapNodeT | null
  /** True once the editor has changed the document since it loaded and the change is not yet saved. */
  dirty: boolean
}

/**
 * The one owner of the loaded documents (F-3.1) and their autosave (F-3.2). Several documents are
 * loaded at once in the stacked view (F-3.8), each keyed by node id: a `DocumentEditor` loads its
 * id on mount and unloads it on unmount, and every edit lands here under its own id and is
 * written through `document:save` after a per-document debounce, on Ctrl+S (`saveNow`), when its
 * region unmounts (`unload`), and when the project closes (via the pending-save registry). Only a
 * successful save clears `dirty`. The pending jobs, timers, and load tokens live at module level
 * so an unmounting editor can never orphan a save.
 */
interface DocumentState {
  /** Every loaded document by node id; an entry appears as soon as `load` starts so the pane can tell loading from empty. */
  docs: Record<string, LoadedDocument>
  /** Loads `id` (waiting first for a pending save of the same id, so a remount reads its own last write). */
  load: (id: string) => Promise<void>
  /** Saves any pending edit to `id` at once (without waiting), then forgets the document. */
  unload: (id: string) => void
  /** Records the latest editor state of `id` and (re)starts its debounce timer. Ignored for ids that are not loaded. */
  edit: (id: string, content: TiptapNodeT) => void
  /**
   * Writes every pending edit (one job per document, so a failed save for one document survives
   * edits to another) and updates the tree's word counts. Every job is attempted; the first
   * failure is rethrown afterwards and its job kept for the next attempt unless a newer edit to
   * that document replaced it.
   */
  flush: () => Promise<void>
  /** Ctrl+S: flush now and toast on failure. */
  saveNow: () => Promise<void>
  /** Flushes every pending save (without waiting), unregisters from the registry, and empties the store. */
  clear: () => void
}

interface SaveJob {
  id: string
  content: TiptapNodeT
}

/** The latest unsaved edit per document id; empty when everything is written. */
const pending = new Map<string, SaveJob>()
/** The running debounce timer per document id. */
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

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

/** Clears `dirty` on a document that is still loaded; a no-op for anything else. */
function markClean(id: string): void {
  useDocumentStore.setState((s) => {
    const doc = s.docs[id]
    if (!doc?.dirty) return {}
    return { docs: { ...s.docs, [id]: { ...doc, dirty: false } } }
  })
}

async function write(job: SaveJob): Promise<void> {
  try {
    const { wordCount } = await ipc().invoke('document:save', job)
    useTreeStore.getState().setWordCount(job.id, wordCount)
    if (!pending.has(job.id)) markClean(job.id)
  } catch (err) {
    if (!pending.has(job.id)) pending.set(job.id, job) // keep it for the next attempt; a newer edit wins
    throw err
  }
}

/**
 * Writes the pending jobs that `wanted` selects, in queue order. Writes are serialized: wait for
 * the one on the wire (its own caller reports its failure) so a close or quit cannot outrun a
 * save that already left, and an older write never lands last. Every selected job is attempted;
 * the first failure is rethrown at the end.
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

export const useDocumentStore = create<DocumentState>((set, get) => ({
  docs: {},

  async load(id) {
    unregister ??= registerPendingSave(() => get().flush())
    const mine = ++lastToken
    loadTokens.set(id, mine)
    set((s) => ({ docs: { ...s.docs, [id]: { content: null, dirty: false } } }))
    // A region that remounts right after its unload must read back its own last write, which may
    // still be queued behind another document's save. Failures are reported by the flush that
    // queued the job.
    if (pending.has(id)) {
      await get()
        .flush()
        .catch(() => undefined)
      if (loadTokens.get(id) !== mine) return
    }
    const doc = await ipc().invoke('document:get', { id })
    if (loadTokens.get(id) !== mine) return // unloaded, cleared, or loaded again while in flight
    set((s) => ({ docs: { ...s.docs, [id]: { content: doc.content ?? EMPTY_DOC, dirty: false } } }))
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
    if (!doc.dirty) set((s) => ({ docs: { ...s.docs, [id]: { ...doc, dirty: true } } }))
    cancelTimer(id)
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        drain((jobId) => jobId === id).catch(reportFailure)
      }, AUTOSAVE_DELAY_MS)
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

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export function resetDocumentStore(): void {
  cancelAllTimers()
  pending.clear()
  inflight = null
  unregister?.()
  unregister = null
  loadTokens.clear()
  useDocumentStore.setState({ docs: {} })
}
