import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { SideWorkFocus } from './sideWork'

/**
 * The frame of side work in the assistant column (2026-10-10): a titled region with "Back to the
 * conversation" (hides it; the run goes on under its status-bar item) that takes the focus when
 * it appears, as the author opened it. Escape is the screen's own (Stop while running, Close
 * after), kept from the window it replaces. It never covers the editor: the editor stays usable
 * beside it the whole time.
 */
export function SideWorkFrame({
  title,
  testId,
  onEscape,
  onHide,
  children
}: {
  title: string
  testId: string
  onEscape: () => void
  onHide: () => void
  children: ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const frame = useRef<HTMLElement>(null)
  // True while the focus is inside the frame; a deck mounting later takes the focus only then.
  const inside = useRef(true)
  const takesFocus = useCallback(() => inside.current, [])

  useEffect(() => {
    // A deck already took the focus on mount (its effect runs first); otherwise the frame does.
    const el = frame.current
    if (el !== null && !el.contains(document.activeElement)) el.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onEscape()
  }

  return (
    <section
      ref={frame}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={onKeyDown}
      onFocus={() => {
        inside.current = true
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) inside.current = false
      }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        <h3 id={titleId} className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h3>
        <button
          type="button"
          data-testid="side-work-hide"
          onClick={onHide}
          className="flex items-center gap-1 rounded px-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          <ArrowLeft size={12} aria-hidden="true" />
          Back to the conversation
        </button>
      </div>
      <SideWorkFocus.Provider value={takesFocus}>{children}</SideWorkFocus.Provider>
    </section>
  )
}
