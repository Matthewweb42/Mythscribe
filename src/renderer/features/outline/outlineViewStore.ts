import { create } from 'zustand'

/** How the main pane shows a selected folder (F-11.1): its documents stacked, or its children as index cards. */
export type FolderView = 'stacked' | 'cork'
export const FOLDER_VIEWS: readonly FolderView[] = ['stacked', 'cork']
export const FOLDER_VIEW_LABEL: Record<FolderView, string> = {
  stacked: 'Stacked',
  cork: 'Cork board'
}

/** How the Outline tab shows the manuscript (F-11.1b): the outline tree, or laid against the structure template's beats. */
export type OutlineMode = 'outline' | 'beats'

/**
 * The folder view choice (F-11.1): session-only view state, like the entity tabs' list/card
 * choice (F-9.2), so it is held in memory and never persisted. One choice for every folder: the
 * author who plans on the cork board keeps it while moving between chapters. The Outline tab's
 * outline/beats choice (F-11.1b) is held the same way.
 */
interface OutlineViewState {
  folderView: FolderView
  setFolderView: (view: FolderView) => void
  outlineMode: OutlineMode
  setOutlineMode: (mode: OutlineMode) => void
}

export const useOutlineViewStore = create<OutlineViewState>((set, get) => ({
  folderView: 'stacked',
  setFolderView(view) {
    if (get().folderView !== view) set({ folderView: view })
  },
  outlineMode: 'outline',
  setOutlineMode(mode) {
    if (get().outlineMode !== mode) set({ outlineMode: mode })
  }
}))

/** Back to the stacked view and the outline. For tests only. */
export function resetOutlineViewStore(): void {
  useOutlineViewStore.setState({ folderView: 'stacked', outlineMode: 'outline' })
}
