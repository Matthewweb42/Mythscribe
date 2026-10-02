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

/** How long `editorFor` waits for the document a caller just selected to mount its editor. */
export const OPEN_SCENE_TIMEOUT_MS = 3_000

/** The waits `editorFor` has open, each settled with null by `resetActiveEditorStore`. */
const waits = new Set<() => void>()

/**
 * The live editor of `nodeId`: the one already registered, or the one the document mounts after
 * the selection changed. Null when none arrives within `OPEN_SCENE_TIMEOUT_MS` (the document is
 * open all the same; only the passage cannot be selected).
 */
export function editorFor(nodeId: string): Promise<Editor | null> {
  const liveOne = (active: ActiveEditor | null): Editor | null =>
    active !== null && active.id === nodeId && !active.editor.isDestroyed ? active.editor : null
  const current = liveOne(useActiveEditorStore.getState().active)
  if (current !== null) return Promise.resolve(current)
  return new Promise((resolve) => {
    let stopWatching: (() => void) | null = null
    const settle = (editor: Editor | null): void => {
      clearTimeout(waiting)
      stopWatching?.()
      waits.delete(giveUp)
      resolve(editor)
    }
    const giveUp = (): void => settle(null)
    const waiting = setTimeout(giveUp, OPEN_SCENE_TIMEOUT_MS)
    waits.add(giveUp)
    stopWatching = useActiveEditorStore.subscribe((state) => {
      const editor = liveOne(state.active)
      if (editor !== null) settle(editor)
    })
  })
}

/**
 * Drops the registration and gives up every open `editorFor` wait, so a jump one test started
 * cannot land in the next one's editor. For tests only.
 */
export function resetActiveEditorStore(): void {
  for (const giveUp of [...waits]) giveUp()
  useActiveEditorStore.setState({ active: null })
}
