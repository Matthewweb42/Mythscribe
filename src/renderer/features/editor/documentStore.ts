import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { noteChapterSaved } from '@renderer/features/editFlow/chapterTriggers'
import { useGoalsStore } from '@renderer/features/goals/goalsStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { noteSaved } from '@renderer/features/memory/readerTriggers'
import { ipc } from '@renderer/lib/ipc'
import { createAutosaveStore, type LoadedRecord } from './autosaveStore'

export { AUTOSAVE_DELAY_MS } from './autosaveStore'

/** One loaded document (F-3.1). */
export type LoadedDocument = LoadedRecord<TiptapNodeT>

/**
 * The one owner of the loaded documents (F-3.1) and their autosave (F-3.2): an autosave store
 * over `document:get` and `document:save`. A successful save also updates the tree's cached
 * word count, so the rollups follow the text without a reload, asks the goals (F-10.3) for
 * today's words again, restarts story memory v2's idle pause (F-16.16), and marks the scene's
 * chapter written in (notes redesign phase 3). Unsaved typing is also kept in the
 * crash-recovery journal (F-8.3).
 */
const documentStore = createAutosaveStore({
  empty: EMPTY_DOC,
  get: async (id) => (await ipc().invoke('document:get', { id })).content,
  save: (id, content) => ipc().invoke('document:save', { id, content }),
  onSaved: (id, { wordCount }) => {
    useTreeStore.getState().setWordCount(id, wordCount)
    useGoalsStore.getState().refreshSoon()
    // F-16.16 (story memory v2): the open scene's idle pause starts again.
    noteSaved(id)
    // Notes redesign phase 3 (v1): its chapter was written in (the automatic notes update).
    noteChapterSaved(id)
  },
  journal: {
    stash: (id, content) => ipc().invoke('recovery:stash', { kind: 'document', id, content }),
    clear: (id) => ipc().invoke('recovery:clear', { kind: 'document', id })
  }
})

export const useDocumentStore = documentStore.useStore

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export const resetDocumentStore = documentStore.reset
