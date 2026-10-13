import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useRecordStore } from './recordStore'

/**
 * Opens a record's sheet in the main pane and its category's section in the sidebar (opening the
 * sidebar when it is closed): the Cast, the who-knows-what grid and a secret's links.
 */
export function openRecordSheet(recordId: string, categoryId: string): void {
  useRecordStore.getState().select(recordId)
  const layout = useLayoutStore.getState()
  layout.setSidebarTab(categoryId)
  if (!layout.layout.sidebar.open) layout.toggle('sidebar')
}
