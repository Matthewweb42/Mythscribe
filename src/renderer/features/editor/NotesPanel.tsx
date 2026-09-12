import { useCallback, useEffect, useRef, useState } from 'react'
import { StickyNote } from 'lucide-react'
import { NotesEditor } from './NotesEditor'
import { MIN_WIDTH, useNotesPanelStore } from './notesPanelStore'

/** How far one arrow key moves the drag handle. */
const KEY_STEP = 16

const BUTTON =
  'rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent'

/** The toolbar toggle for the notes panel (F-3.7); `aria-pressed` reflects whether it is open. */
export function NotesToggleButton(): React.JSX.Element {
  const open = useNotesPanelStore((s) => s.open)
  const toggle = useNotesPanelStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="Notes"
      title="Notes"
      aria-pressed={open}
      onClick={toggle}
      className={BUTTON}
    >
      <StickyNote size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The notes side panel (F-3.7): a column beside the editor hosting the `NotesEditor` for the
 * selected node, resizable by dragging its left edge or with the arrow keys on the handle.
 * The width is clamped between `MIN_WIDTH` and half of the container, measured with a
 * ResizeObserver so a shrinking window never lets the notes squeeze the editor out. Renders
 * nothing while closed, so the editor gets the whole pane and no notes are loaded.
 */
export function NotesPanel({ id }: { id: string }): React.JSX.Element | null {
  const open = useNotesPanelStore((s) => s.open)
  if (!open) return null
  return <OpenNotesPanel id={id} />
}

function OpenNotesPanel({ id }: { id: string }): React.JSX.Element {
  const width = useNotesPanelStore((s) => s.width)
  const setWidth = useNotesPanelStore((s) => s.setWidth)
  const root = useRef<HTMLDivElement>(null)
  /** Half the container's width; Infinity until it has been laid out (jsdom, or a hidden pane). */
  const [max, setMax] = useState(Infinity)
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const container = root.current?.parentElement
    if (!container) return
    const measure = (): void => {
      const half = Math.floor(container.clientWidth / 2)
      setMax(half > 0 ? half : Infinity)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const clamp = useCallback(
    (value: number): number => Math.max(MIN_WIDTH, Math.min(Math.round(value), max)),
    [max]
  )
  const shown = clamp(width)

  useEffect(() => {
    if (!drag) return
    // The panel sits on the right, so moving the handle left widens it.
    const onMove = (event: PointerEvent): void => {
      setWidth(clamp(drag.startWidth + (drag.startX - event.clientX)))
    }
    const onUp = (): void => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, clamp, setWidth])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setWidth(clamp(shown + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)))
  }

  return (
    <div
      ref={root}
      data-testid="notes-panel"
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width: shown }}
    >
      <div
        role="separator"
        aria-label="Resize notes"
        aria-orientation="vertical"
        aria-valuenow={shown}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          setDrag({ startX: event.clientX, startWidth: shown })
        }}
        onKeyDown={onKeyDown}
        className={`absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/40 ${drag ? 'bg-accent/40' : ''}`}
      />
      <h2 className="m-0 shrink-0 px-4 pt-4 pb-2 text-sm font-medium text-fg-muted">Notes</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <NotesEditor id={id} />
      </div>
    </div>
  )
}
