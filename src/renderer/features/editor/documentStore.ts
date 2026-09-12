import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { ipc } from '@renderer/lib/ipc'
import { createAutosaveStore, type LoadedRecord } from './autosaveStore'

export { AUTOSAVE_DELAY_MS } from './autosaveStore'

/** One loaded document (F-3.1). */
export type LoadedDocument = LoadedRecord<TiptapNodeT>

/**
 * The one owner of the loaded documents (F-3.1) and their autosave (F-3.2): an autosave store
 * over `document:get` and `document:save`. A successful save also updates the tree's cached
 * word count, so the rollups follow the text without a reload.
 */
const documentStore = createAutosaveStore({
  empty: EMPTY_DOC,
  get: async (id) => (await ipc().invoke('document:get', { id })).content,
  save: (id, content) => ipc().invoke('document:save', { id, content }),
  onSaved: (id, { wordCount }) => useTreeStore.getState().setWordCount(id, wordCount)
})

export const useDocumentStore = documentStore.useStore

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export const resetDocumentStore = documentStore.reset
