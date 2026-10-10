import { AssistantBody } from '@renderer/features/ai/AssistantPanel'
import { NotesColumn } from '@renderer/features/editor/NotesPanel'
import {
  AddReferenceImageButton,
  ReferencesBody
} from '@renderer/features/references/ReferencePanel'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { FloatingWindow } from './FloatingWindow'
import { useFocusStore } from './focusStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'

/**
 * The floating Notes, References, and AI assistant windows of focus mode (F-6.6; References
 * since 2026-10-07: the pins and the open scene's story bible sheets), mounted by `App` only
 * there and shown on the focus store's session flags (the control bar's buttons toggle them,
 * F-6.5; each window's Close and Escape clear its flag). The notes window hosts `NotesColumn`
 * for the selected node, the docked panel's synopsis, notes, and scene details (2026-10-10); the assistant window
 * hosts `AssistantBody`, which carries its own New conversation button and Continuity link; the
 * references window hosts `ReferencesBody` with Add image in its title bar. Their geometry is the layout's
 * `floating` rects, persisted app-wide like the docked sizes.
 */
export function FocusFloatingPanels(): React.JSX.Element {
  const panels = useFocusStore((s) => s.panels)
  const togglePanel = useFocusStore((s) => s.togglePanel)
  const assistantName = useAssistantName()
  const selectedId = useTreeStore((s) => s.selectedId)
  return (
    <>
      {panels.notes ? (
        <FloatingWindow name="notes" title="Notes" onClose={() => togglePanel('notes')}>
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            <NotesColumn id={selectedId} />
          </div>
        </FloatingWindow>
      ) : null}
      {panels.references ? (
        <FloatingWindow
          name="references"
          title="References"
          actions={<AddReferenceImageButton />}
          onClose={() => togglePanel('references')}
        >
          <div className="flex min-h-0 flex-1 flex-col pt-3">
            <ReferencesBody />
          </div>
        </FloatingWindow>
      ) : null}
      {panels.assistant ? (
        <FloatingWindow
          name="assistant"
          title={assistantName}
          onClose={() => togglePanel('assistant')}
        >
          <AssistantBody />
        </FloatingWindow>
      ) : null}
    </>
  )
}
