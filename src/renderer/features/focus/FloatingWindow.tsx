import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import {
  FLOATING_KEY_STEP_PX,
  RESIZE_EDGES,
  resizeRect,
  type FloatingPanel,
  type Rect,
  type ResizeEdge
} from '@shared/layout'
import {
  moveFloatingBy,
  resizeFloatingBy,
  useLayoutStore
} from '@renderer/features/shell/layoutStore'

const TITLE_HINT = 'Drag to move. Arrow keys move, Shift+arrow keys resize.'

/**
 * Where a title-bar or edge drag started: the pointer and the rect at pointer-down. Every
 * move is computed from here, not from the previous move, so sub-pixel pointer steps (a
 * zoomed display, a synthetic drag in steps) never lose distance to the store's rounding.
 */
interface DragOrigin {
  x: number
  y: number
  rect: Rect
}

/** A resize drag: its origin and the edge or corner being dragged. */
interface ResizeOrigin extends DragOrigin {
  edge: ResizeEdge
}

/**
 * Where each resize handle sits and the cursor it shows. The edges are 6 px strips inside the
 * window's border, the corners 12 px squares above them (later in document order), so a corner
 * wins where they overlap. The bottom-right corner also draws the visible grip.
 */
const HANDLE: Record<ResizeEdge, string> = {
  n: 'top-0 right-3 left-3 h-1.5 cursor-ns-resize',
  s: 'right-3 bottom-0 left-3 h-1.5 cursor-ns-resize',
  e: 'top-3 right-0 bottom-3 w-1.5 cursor-ew-resize',
  w: 'top-3 bottom-3 left-0 w-1.5 cursor-ew-resize',
  ne: 'top-0 right-0 h-3 w-3 cursor-nesw-resize',
  sw: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize',
  nw: 'top-0 left-0 h-3 w-3 cursor-nwse-resize',
  se: 'right-0 bottom-0 h-4 w-4 cursor-nwse-resize'
}

/** Edges first, corners last, so a corner is on top where it overlaps an edge strip. */
const HANDLE_ORDER: readonly ResizeEdge[] = [
  ...RESIZE_EDGES.filter((edge) => edge.length === 1),
  ...RESIZE_EDGES.filter((edge) => edge.length === 2)
]

/** The arrow keys as `[dx, dy]` unit steps. */
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}

interface FloatingWindowProps {
  /** Which window: its geometry lives in `layout.floating[name]`. */
  name: FloatingPanel
  /** The window's name: the title bar's text and the dialog's accessible name. */
  title: string
  /** Extra controls shown in the title bar between the title and Close (the assistant's New conversation). */
  actions?: ReactNode
  /** Close button, and Escape anywhere inside the window. */
  onClose: () => void
  children: ReactNode
}

/**
 * A floating, non-modal window for focus mode (F-6.6): a `dialog` positioned in px from the
 * layout store's `floating[name]` rect, moved by dragging its title bar and sized by dragging
 * any edge or corner like a desktop window (2026-10-07; `resizeRect` keeps the opposite edges
 * put; the bottom-right corner keeps a visible grip), all with pointer capture, so a fast
 * pointer never escapes, and measured from the drag's origin; or with the keyboard on the focused title
 * bar: the arrow keys move it by `FLOATING_KEY_STEP_PX`, Shift+arrows resize it. Every change
 * goes through the store, which clamps the rect into the viewport and persists it with the
 * layout's debounced write; the window re-clamps itself on mount and on every window resize,
 * so it is never off-screen. Escape inside the window closes it in the capture phase, so
 * neither an editor inside nor the focus-mode listener sees the key and focus mode stays.
 * Keyboard focus is not trapped: the window is a sibling of the editor, not a modal.
 */
export function FloatingWindow({
  name,
  title,
  actions,
  onClose,
  children
}: FloatingWindowProps): React.JSX.Element {
  const rect = useLayoutStore((s) => s.layout.floating[name])
  const setFloatingRect = useLayoutStore((s) => s.setFloatingRect)
  const [moving, setMoving] = useState<DragOrigin | null>(null)
  const [sizing, setSizing] = useState<ResizeOrigin | null>(null)

  // Re-clamp on mount (a rect stored on a larger display) and when the window shrinks; the
  // store ignores a rect that already fits, so this writes only when something moved.
  useEffect(() => {
    const fit = (): void => setFloatingRect(name, useLayoutStore.getState().layout.floating[name])
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [name, setFloatingRect])

  const startDrag =
    (start: (origin: DragOrigin) => void) =>
    (event: PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      start({ x: event.clientX, y: event.clientY, rect })
    }

  const startResize = (edge: ResizeEdge): ((event: PointerEvent<HTMLDivElement>) => void) =>
    startDrag((origin) => setSizing({ ...origin, edge }))

  const onTitleMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (moving === null) return
    const { rect: from } = moving
    setFloatingRect(name, {
      ...from,
      x: from.x + event.clientX - moving.x,
      y: from.y + event.clientY - moving.y
    })
  }

  const onResizeMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (sizing === null) return
    setFloatingRect(
      name,
      resizeRect(sizing.rect, sizing.edge, event.clientX - sizing.x, event.clientY - sizing.y, {
        width: window.innerWidth,
        height: window.innerHeight
      })
    )
  }

  const onTitleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = ARROWS[event.key]
    if (!step) return
    event.preventDefault()
    const [dx, dy] = step
    if (event.shiftKey) resizeFloatingBy(name, dx * FLOATING_KEY_STEP_PX, dy * FLOATING_KEY_STEP_PX)
    else moveFloatingBy(name, dx * FLOATING_KEY_STEP_PX, dy * FLOATING_KEY_STEP_PX)
  }

  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <section
      role="dialog"
      aria-label={title}
      data-testid={`floating-${name}`}
      onKeyDownCapture={onKeyDownCapture}
      className="fixed z-10 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-panel"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line pr-1">
        <div
          role="group"
          aria-label={`${title} window`}
          title={TITLE_HINT}
          tabIndex={0}
          data-testid={`floating-${name}-title`}
          onPointerDown={startDrag(setMoving)}
          onPointerMove={onTitleMove}
          onPointerUp={() => setMoving(null)}
          onPointerCancel={() => setMoving(null)}
          onKeyDown={onTitleKeyDown}
          className={`flex min-w-0 flex-1 touch-none items-center px-3 py-2 select-none focus-visible:outline-2 focus-visible:outline-accent ${moving === null ? 'cursor-grab' : 'cursor-grabbing'}`}
        >
          <h2 className="m-0 truncate text-sm font-medium text-fg-muted">{title}</h2>
        </div>
        {actions}
        <button
          type="button"
          aria-label={`Close ${title}`}
          title="Close (Escape)"
          onClick={onClose}
          className="rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {HANDLE_ORDER.map((edge) => (
        <div
          key={edge}
          aria-hidden="true"
          data-testid={edge === 'se' ? `floating-${name}-grip` : `floating-${name}-resize-${edge}`}
          data-edge={edge}
          onPointerDown={startResize(edge)}
          onPointerMove={onResizeMove}
          onPointerUp={() => setSizing(null)}
          onPointerCancel={() => setSizing(null)}
          className={`absolute z-10 touch-none ${HANDLE[edge]} ${sizing?.edge === edge ? 'bg-accent/40' : 'hover:bg-accent/40'}`}
        >
          {edge === 'se' ? <GripMark /> : null}
        </div>
      ))}
    </section>
  )
}

/** The visible bottom-right grip: three short diagonal strokes, as on a desktop window. */
function GripMark(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="pointer-events-none h-full w-full text-fg-subtle"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    >
      <path d="M13 6 6 13M13 9.5 9.5 13M13 3 3 13" />
    </svg>
  )
}
