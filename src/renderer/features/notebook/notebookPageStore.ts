import type { NotebookPage } from '@shared/notebook'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { createAutosaveStore } from '@renderer/features/editor/autosaveStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * The open note page's text (notes redesign phase 1, slice 1): an autosave instance of its own
 * (F-3.2's debounce, Ctrl+S, the flush on unmount and on project close), keyed by page id, read
 * with `notebook:get` and written with `notebook:update`, which keeps no version (the author's
 * own typing). The tree and the page's title are the notebook store's.
 */
const notebookPages = createAutosaveStore<TiptapNodeT, NotebookPage>({
  empty: EMPTY_DOC,
  get: async (id) => (await ipc().invoke('notebook:get', { id })).content,
  save: (id, content) => ipc().invoke('notebook:update', { id, content })
})

export const useNotebookPageStore = notebookPages.useStore

/** Drops the pending jobs, timers and loads, then empties the store. For tests only. */
export const resetNotebookPageStore = notebookPages.reset
