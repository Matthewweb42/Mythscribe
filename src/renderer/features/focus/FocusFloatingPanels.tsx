import { AssistantBody, NewConversationButton } from '@renderer/features/ai/AssistantPanel'
import { NotesBody } from '@renderer/features/editor/NotesPanel'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { FloatingWindow } from './FloatingWindow'
import { useFocusStore } from './focusStore'

/**
 * The floating Notes and AI assistant windows of focus mode (F-6.6), mounted by `App` only
 * there and shown on the focus store's session flags (the control bar's buttons toggle them,
 * F-6.5; each window's Close and Escape clear its flag). The notes window hosts `NotesBody`
 * for the selected node, the same editor and store as the docked panel; the assistant window
 * hosts `AssistantBody` with New conversation in its title bar. Their geometry is the layout's
 * `floating` rects, persisted app-wide like the docked sizes.
 */
export function FocusFloatingPanels(): React.JSX.Element {
  const panels = useFocusStore((s) => s.panels)
  const togglePanel = useFocusStore((s) => s.togglePanel)
  const selectedId = useTreeStore((s) => s.selectedId)
  return (
    <>
      {panels.notes ? (
        <FloatingWindow name="notes" title="Notes" onClose={() => togglePanel('notes')}>
          {selectedId === null ? (
            <p className="m-0 px-4 py-3 text-sm text-fg-muted">
              Select a document to see its notes.
            </p>
          ) : (
            <NotesBody id={selectedId} />
          )}
        </FloatingWindow>
      ) : null}
      {panels.assistant ? (
        <FloatingWindow
          name="assistant"
          title="Assistant"
          actions={<NewConversationButton />}
          onClose={() => togglePanel('assistant')}
        >
          <AssistantBody />
        </FloatingWindow>
      ) : null}
    </>
  )
}
