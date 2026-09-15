import { StickyNote } from 'lucide-react'
import { LAYOUT_LIMITS } from '@shared/layout'
import { resizePanelBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { NotesEditor } from './NotesEditor'

const BUTTON =
  'rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent'

/** The toolbar toggle for the notes panel (F-3.7); `aria-pressed` reflects whether it is open. */
export function NotesToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.notes.open)
  const toggle = useLayoutStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="Notes"
      title="Notes"
      aria-pressed={open}
      onClick={() => toggle('notes')}
      className={BUTTON}
    >
      <StickyNote size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The notes side panel (F-3.7): a column beside the editor hosting the `NotesEditor` for the
 * selected node, resizable by dragging its left edge or with the arrow keys on the handle.
 * Its open state and width live in the layout store (F-7.2), as a fraction of the window
 * rendered in `vw`, so it follows a window resize on its own and is back after a restart.
 * Renders nothing while closed, so the editor gets the whole pane and no notes are loaded.
 * Not mounted in focus mode, where `NotesBody` floats instead (F-6.6).
 */
export function NotesPanel({ id }: { id: string }): React.JSX.Element | null {
  const notes = useLayoutStore((s) => s.layout.notes)
  if (!notes.open) return null
  return (
    <div
      data-testid="notes-panel"
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width: `${notes.size * 100}vw` }}
    >
      <ResizeHandle
        side="left"
        value={notes.size}
        min={LAYOUT_LIMITS.notes[0]}
        max={LAYOUT_LIMITS.notes[1]}
        ariaLabel="Resize notes"
        onChange={(deltaPx) => resizePanelBy('notes', deltaPx)}
      />
      <h2 className="m-0 shrink-0 px-4 pt-4 pb-2 text-sm font-medium text-fg-muted">Notes</h2>
      <NotesBody id={id} />
    </div>
  )
}

/**
 * The scrolling notes editor for one node: the docked panel's content under its heading, and
 * the floating window's whole content in focus mode (F-6.6), so both edit the same notes
 * through the same store.
 */
export function NotesBody({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <NotesEditor id={id} />
    </div>
  )
}
