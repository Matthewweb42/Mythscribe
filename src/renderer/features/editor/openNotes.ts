import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'

/**
 * Opens node `nodeId` with its notes showing (F-10.1's notes hits, F-16.25's cited scene notes):
 * selects it and shows the notes panel, the floating one in focus mode, the docked one otherwise.
 */
export function openNotesOf(nodeId: string): void {
  useTreeStore.getState().select(nodeId)
  const focus = useFocusStore.getState()
  if (focus.active) {
    if (!focus.panels.notes) focus.togglePanel('notes')
    return
  }
  const layout = useLayoutStore.getState()
  if (!layout.layout.notes.open) layout.toggle('notes')
}
