import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'

/**
 * Opens a Research page (F-16.8): the sidebar's Research tab and the page, which the tree's
 * selection opens in the page editor. The page editor takes no passage jump yet, so a caller that
 * points at a paragraph (a search hit, a cited source) lands on the page, not the paragraph.
 */
export function openResearchPage(nodeId: string): void {
  useLayoutStore.getState().setSidebarTab('research')
  useTreeStore.getState().select(nodeId)
}
