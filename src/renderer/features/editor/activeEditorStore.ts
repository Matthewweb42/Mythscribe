import { create } from 'zustand'
import type { Editor } from '@tiptap/core'

/** The document editor the author last worked in: its node id and the live Tiptap instance. */
export interface ActiveEditor {
  id: string
  editor: Editor
}

/**
 * The one way anything outside the editing surface reaches the editor (F-5.4): the assistant
 * panel places Agent-mode text as ghost text at its caret and sends its node as the scene
 * whose text rides along. `DocumentEditor` registers each instance when it is ready and again
 * when it gains focus (so the last-focused region of a stack wins), and releases it on
 * unmount, so a switched document or a closed project never leaves a destroyed editor here.
 */
interface ActiveEditorState {
  active: ActiveEditor | null
  set: (id: string, editor: Editor) => void
  /** Drops `editor` if it is the active one; another instance's registration is left alone. */
  release: (editor: Editor) => void
}

export const useActiveEditorStore = create<ActiveEditorState>((set, get) => ({
  active: null,

  set(id, editor) {
    const current = get().active
    if (current?.id === id && current.editor === editor) return
    set({ active: { id, editor } })
  },

  release(editor) {
    if (get().active?.editor === editor) set({ active: null })
  }
}))

/** Drops the registration. For tests only. */
export function resetActiveEditorStore(): void {
  useActiveEditorStore.setState({ active: null })
}
