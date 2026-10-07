import { create } from 'zustand'

/**
 * What the Edits feature (F-14.15) shows in the main pane: the workspace where a pass is set up
 * and watched, or one pass's report. Its own tiny store with no imports, so the tree and entity
 * stores can close it on a selection without an import cycle (like F-9.3's entity page, picking
 * a document or an entity takes the pane back).
 */
export type EditPassView = { kind: 'workspace' } | { kind: 'report'; passId: string }

interface EditPassViewState {
  view: EditPassView | null
  open: (view: EditPassView) => void
  close: () => void
}

export const useEditPassViewStore = create<EditPassViewState>((set, get) => ({
  view: null,
  open(view) {
    set({ view })
  },
  close() {
    if (get().view !== null) set({ view: null })
  }
}))

/** Closes the view. For tests only. */
export function resetEditPassViewStore(): void {
  useEditPassViewStore.setState({ view: null })
}
