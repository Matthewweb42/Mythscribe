import { create } from 'zustand'

/** The notes panel's width when first opened (F-3.7). */
export const DEFAULT_WIDTH = 320
/** The narrowest the notes panel can be dragged. */
export const MIN_WIDTH = 200

/**
 * Whether the notes side panel (F-3.7) is open and how wide it is. In memory only, so it
 * survives switching documents and projects within a session; F-7.2 persists pane sizes.
 */
interface NotesPanelState {
  open: boolean
  width: number
  toggle: () => void
  /** Stores a width; never below `MIN_WIDTH`. The panel applies the container-based maximum. */
  setWidth: (width: number) => void
}

export const useNotesPanelStore = create<NotesPanelState>((set) => ({
  open: false,
  width: DEFAULT_WIDTH,
  toggle: () => set((s) => ({ open: !s.open })),
  setWidth: (width) => set({ width: Math.max(MIN_WIDTH, width) })
}))

/** Closes the panel and restores the default width. For tests only. */
export function resetNotesPanelStore(): void {
  useNotesPanelStore.setState({ open: false, width: DEFAULT_WIDTH })
}
