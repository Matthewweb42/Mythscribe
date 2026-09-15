import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { FLOATING_KEY_STEP_PX, type FloatingPanel, type Rect } from '@shared/layout'
import {
  moveFloatingBy,
  resizeFloatingBy,
  useLayoutStore
} from '@renderer/features/shell/layoutStore'

const TITLE_HINT = 'Drag to move. Arrow keys move, Shift+arrow keys resize.'

/**
 * Where a title-bar or grip drag started: the pointer and the rect at pointer-down. Every
 * move is computed from here, not from the previous move, so sub-pixel pointer steps (a
 * zoomed display, a synthetic drag in steps) never lose distance to the store's rounding.
 */
interface DragOrigin {
  x: number
  y: number
  rect: Rect
}

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
 * the grip in its bottom-right corner (both with pointer capture, so a fast pointer never
 * escapes, and measured from the drag's origin), or with the keyboard on the focused title
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
  const [sizing, setSizing] = useState<DragOrigin | null>(null)

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

  const onTitleMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (moving === null) return
    const { rect: from } = moving
    setFloatingRect(name, {
      ...from,
      x: from.x + event.clientX - moving.x,
      y: from.y + event.clientY - moving.y
    })
  }

  const onGripMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (sizing === null) return
    const { rect: from } = sizing
    setFloatingRect(name, {
      ...from,
      width: from.width + event.clientX - sizing.x,
      height: from.height + event.clientY - sizing.y
    })
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
      <div
        aria-hidden="true"
        data-testid={`floating-${name}-grip`}
        onPointerDown={startDrag(setSizing)}
        onPointerMove={onGripMove}
        onPointerUp={() => setSizing(null)}
        onPointerCancel={() => setSizing(null)}
        className={`absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none ${sizing === null ? 'hover:bg-accent/40' : 'bg-accent/40'}`}
      />
    </section>
  )
}
