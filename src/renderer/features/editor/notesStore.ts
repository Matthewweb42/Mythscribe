import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { ipc } from '@renderer/lib/ipc'
import { createAutosaveStore, type LoadedRecord } from './autosaveStore'

export { AUTOSAVE_DELAY_MS } from './autosaveStore'

/** One loaded notes record (F-3.7). */
export type LoadedNotes = LoadedRecord<TiptapNodeT>

/**
 * The one owner of the loaded notes (F-3.7) and their autosave: a second autosave store, over
 * `notes:get` and `notes:save`, independent of the document store so a document and its notes
 * save side by side under the same id and a failure in one never blocks the other.
 */
const notesStore = createAutosaveStore({
  empty: EMPTY_DOC,
  get: async (id) => (await ipc().invoke('notes:get', { id })).notes,
  save: (id, notes) => ipc().invoke('notes:save', { id, notes })
})

export const useNotesStore = notesStore.useStore

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export const resetNotesStore = notesStore.reset
