import { create } from 'zustand'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long after the last edit the debounced save fires (F-3.2). */
export const AUTOSAVE_DELAY_MS = 1000

/**
 * The one owner of the loaded document (F-3.1) and its autosave (F-3.2). `EditorPane` loads by
 * node id and pushes the resolved content into the editor; every edit lands here and is written
 * through `document:save` after a debounce, on Ctrl+S (`saveNow`), when another document loads,
 * and when the project closes (via the pending-save registry). Only a successful save clears
 * `dirty`. The pending jobs and their timer live at module level, like `generation`, so an
 * unmounting editor can never orphan a save.
 */
interface DocumentState {
  /** The node being shown; set as soon as `load` starts so the pane can tell loading from empty. */
  id: string | null
  /** The document as loaded; null until `document:get` resolves. A never-written node loads as `EMPTY_DOC`. */
  content: TiptapNodeT | null
  /** True once the editor has changed the document since it loaded and the change is not yet saved. */
  dirty: boolean
  /** Flushes any pending save for the previous document (without waiting), then loads `id`. */
  load: (id: string) => Promise<void>
  /** Records the latest editor state and (re)starts the debounce timer. Ignored with no document loaded. */
  edit: (content: TiptapNodeT) => void
  /**
   * Writes every pending edit (one job per document, so a failed save for the previous document
   * survives edits to the next one) and updates the tree's word counts. Rejects on failure and
   * keeps the failed job for the next attempt unless a newer edit to that document replaced it.
   */
  flush: () => Promise<void>
  /** Ctrl+S: flush now and toast on failure. */
  saveNow: () => Promise<void>
  /** Flushes any pending save (without waiting), unregisters from the registry, and empties the store. */
  clear: () => void
}

interface SaveJob {
  id: string
  content: TiptapNodeT
}

/** Bumped by every load() and clear() so a response from a superseded load is dropped. */
let generation = 0
/** The latest unsaved edit per document id; empty when everything is written. */
const pending = new Map<string, SaveJob>()
let timer: ReturnType<typeof setTimeout> | null = null
/** The write currently on the wire, so every flush (and the close/quit path) waits for it. */
let inflight: Promise<void> | null = null
/** Removes this store's flusher from the pending-save registry; null while nothing is registered. */
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

async function write(
  job: SaveJob,
  get: () => DocumentState,
  set: (partial: Partial<DocumentState>) => void
): Promise<void> {
  try {
    const { wordCount } = await ipc().invoke('document:save', job)
    useTreeStore.getState().setWordCount(job.id, wordCount)
    if (get().id === job.id && !pending.has(job.id)) set({ dirty: false })
  } catch (err) {
    if (!pending.has(job.id)) pending.set(job.id, job) // keep it for the next attempt; a newer edit wins
    throw err
  }
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  id: null,
  content: null,
  dirty: false,

  async load(id) {
    // Capture the previous document's edits before the id changes; do not wait for the write.
    get().flush().catch(reportFailure)
    unregister ??= registerPendingSave(() => get().flush())
    const mine = ++generation
    set({ id, content: null, dirty: false })
    const doc = await ipc().invoke('document:get', { id })
    if (mine !== generation) return // cleared or another document was requested while in flight
    set({ content: doc.content ?? EMPTY_DOC, dirty: false })
  },

  edit(content) {
    const { id } = get()
    if (id === null) return
    pending.set(id, { id, content })
    set({ dirty: true })
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      get().flush().catch(reportFailure)
    }, AUTOSAVE_DELAY_MS)
  },

  async flush() {
    cancelTimer()
    // Writes are serialized: wait for the one on the wire (its own caller reports its failure) so
    // a close or quit cannot outrun a save that already left, and an older write never lands last.
    while (inflight !== null) await inflight.catch(() => undefined)
    // Every document with an unsaved edit is written, in queue order; a failure stops here and
    // leaves the rest in `pending` for the next attempt.
    for (const job of [...pending.values()]) {
      pending.delete(job.id)
      inflight = write(job, get, set)
      try {
        await inflight
      } finally {
        inflight = null
      }
    }
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
    generation++
    set({ id: null, content: null, dirty: false })
  }
}))

/** Drops the pending job, timer, in-flight write, and registration, then empties the store. For tests only. */
export function resetDocumentStore(): void {
  cancelTimer()
  pending.clear()
  inflight = null
  unregister?.()
  unregister = null
  generation++
  useDocumentStore.setState({ id: null, content: null, dirty: false })
}
