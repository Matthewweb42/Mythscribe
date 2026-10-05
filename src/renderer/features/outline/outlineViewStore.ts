import { create } from 'zustand'

/** How the main pane shows a selected folder (F-11.1): its documents stacked, or its children as index cards. */
export type FolderView = 'stacked' | 'cork'
export const FOLDER_VIEWS: readonly FolderView[] = ['stacked', 'cork']
export const FOLDER_VIEW_LABEL: Record<FolderView, string> = {
  stacked: 'Stacked',
  cork: 'Cork board'
}

/**
 * The folder view choice (F-11.1): session-only view state, like the entity tabs' list/card
 * choice (F-9.2), so it is held in memory and never persisted. One choice for every folder: the
 * author who plans on the cork board keeps it while moving between chapters.
 */
interface OutlineViewState {
  folderView: FolderView
  setFolderView: (view: FolderView) => void
}

export const useOutlineViewStore = create<OutlineViewState>((set, get) => ({
  folderView: 'stacked',
  setFolderView(view) {
    if (get().folderView !== view) set({ folderView: view })
  }
}))

/** Back to the stacked view. For tests only. */
export function resetOutlineViewStore(): void {
  useOutlineViewStore.setState({ folderView: 'stacked' })
}
