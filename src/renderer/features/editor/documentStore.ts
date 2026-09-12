import { create } from 'zustand'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the loaded document (F-3.1). `EditorPane` loads by node id and pushes the
 * resolved content into the editor; F-3.2 adds autosave here (debounced write, Ctrl+S, word
 * count, the pending-save registration) and is the only thing that clears `dirty`.
 */
interface DocumentState {
  /** The node being shown; set as soon as `load` starts so the pane can tell loading from empty. */
  id: string | null
  /** The document as loaded; null until `document:get` resolves. A never-written node loads as `EMPTY_DOC`. */
  content: TiptapNodeT | null
  /** True once the editor has changed the document since it loaded. */
  dirty: boolean
  load: (id: string) => Promise<void>
  setDirty: (dirty: boolean) => void
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded load is dropped. */
let generation = 0

export const useDocumentStore = create<DocumentState>((set) => ({
  id: null,
  content: null,
  dirty: false,

  async load(id) {
    const mine = ++generation
    set({ id, content: null, dirty: false })
    const doc = await ipc().invoke('document:get', { id })
    if (mine !== generation) return // cleared or another document was requested while in flight
    set({ content: doc.content ?? EMPTY_DOC, dirty: false })
  },

  setDirty(dirty) {
    set({ dirty })
  },

  clear() {
    generation++
    set({ id: null, content: null, dirty: false })
  }
}))
