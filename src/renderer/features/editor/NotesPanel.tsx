import { useId } from 'react'
import { ChevronDown, ChevronRight, Pin, StickyNote } from 'lucide-react'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useSessionStore } from '@renderer/features/project/sessionStore'
import { DockPanelControls } from '@renderer/features/shell/Dock'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useReferenceStore } from '@renderer/features/references/referenceStore'
import { MetadataPane, SynopsisBox } from './MetadataPane'
import { NotesEditor } from './NotesEditor'
import { NotesSuggestion, SuggestButton } from './SceneSuggestions'

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
 * The notes panel (F-3.7): a dock panel (layout 3c) for the selected node (`id`; null while an
 * entity page or nothing is selected); its column, width, and resize handle are the dock's
 * (`DockColumn`). Since 2026-10-06 it is the node's whole side panel: for a scene, chapter, or
 * part a compact Synopsis box at the top (`SynopsisBox`), then the notes editor filling the rest
 * as a scratch pad (with Suggest in the heading and the suggested key points over the notes,
 * F-5.20, for a manuscript scene), then a collapsed "Scene details" disclosure with the rest of the metadata
 * (`MetadataPane`: location, POV, timeline, status, beat, brief, AI summary). Its open state
 * lives in the layout store (F-7.2), so it is back after a restart. Renders nothing while closed,
 * so the editor gets the whole pane and no notes are loaded. Not mounted in focus mode, where
 * `NotesBody` floats instead (F-6.6).
 */
export function NotesPanel({ id }: { id: string | null }): React.JSX.Element | null {
  const notes = useLayoutStore((s) => s.layout.notes)
  // Held in the project's session (F-1.7), not in the disclosure, so it stays open across an
  // entity page or a front-matter document in between and comes back with the project.
  const detailsOpen = useSessionStore((s) => s.sceneDetailsOpen)
  const setDetailsOpen = useSessionStore((s) => s.setSceneDetailsOpen)
  if (!notes.open) return null
  return (
    <div data-testid="notes-panel" className="flex min-h-0 flex-1 flex-col bg-surface">
      <NotesHeading id={id} />
      <NotesContent id={id} detailsOpen={detailsOpen} onDetailsOpen={setDetailsOpen} />
    </div>
  )
}

/** The panel's heading: the dock grip and menu, the title, and Suggest and the pin button while a node is shown. */
function NotesHeading({ id }: { id: string | null }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 pt-3 pr-4 pb-2 pl-2">
      <DockPanelControls id="notes" />
      <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-fg-muted">Notes</h2>
      {id === null ? null : <SuggestButton id={id} kind="notes" compact />}
      {id === null ? null : <PinNotesButton id={id} />}
    </div>
  )
}

/**
 * The synopsis, the notes, and the scene details of one node, under the column's heading; a
 * hint while no node is selected. A node without a hierarchy level (front or end matter) has
 * notes only.
 */
function NotesContent({
  id,
  detailsOpen,
  onDetailsOpen
}: {
  id: string | null
  detailsOpen: boolean
  onDetailsOpen: (open: boolean) => void
}): React.JSX.Element {
  const withMetadata = useTreeStore((s) =>
    id === null ? false : (s.byId[id]?.hierarchyLevel ?? null) !== null
  )
  if (id === null)
    return <p className="m-0 px-4 text-sm text-fg-muted">Select a document to see its notes.</p>
  return (
    <>
      {withMetadata ? <SynopsisBox id={id} /> : null}
      <NotesSuggestion id={id} />
      <NotesBody id={id} />
      {withMetadata ? <SceneDetails id={id} open={detailsOpen} onOpen={onDetailsOpen} /> : null}
    </>
  )
}

/**
 * The "Scene details" disclosure at the foot of the notes column: collapsed by default, so the
 * notes keep the column; open, the metadata scrolls in up to half the column's height. The
 * metadata pane is only mounted while it is open; the column owns the open state.
 */
function SceneDetails({
  id,
  open,
  onOpen
}: {
  id: string
  open: boolean
  onOpen: (open: boolean) => void
}): React.JSX.Element {
  const bodyId = useId()
  return (
    <div className="flex max-h-[50%] shrink-0 flex-col border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => onOpen(!open)}
        className="flex shrink-0 items-center gap-1 px-4 py-2 text-xs font-medium text-fg-muted hover:text-fg aria-expanded:text-fg"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        Scene details
      </button>
      {open ? (
        <div id={bodyId} className="min-h-0 overflow-y-auto px-4 pb-4">
          <MetadataPane id={id} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Pins the node's notes to the quick reference panel (F-9.6), or unpins them; `aria-pressed`
 * reflects whether they are pinned. Pinning opens that panel, so the card is seen to arrive.
 */
function PinNotesButton({ id }: { id: string }): React.JSX.Element {
  const pinned = useReferenceStore((s) => s.pins.some((p) => p.type === 'note' && p.id === id))
  const toggle = (): void => {
    const store = useReferenceStore.getState()
    void (pinned ? store.unpin({ type: 'note', id }) : store.pin({ type: 'note', id }))
  }
  return (
    <button
      type="button"
      aria-label={pinned ? 'Unpin notes' : 'Pin notes'}
      title={pinned ? 'Unpin from References' : 'Pin to References'}
      aria-pressed={pinned}
      onClick={toggle}
      className={BUTTON}
    >
      <Pin size={14} aria-hidden="true" />
    </button>
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
