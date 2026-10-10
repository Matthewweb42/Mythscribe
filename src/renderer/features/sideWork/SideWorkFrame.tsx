import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { ArrowLeft } from 'lucide-react'
import { SideWorkFocus, SideWorkPlaceContext } from './sideWork'

/**
 * The frame of side work in the assistant column (2026-10-10): a titled region with "Back to the
 * conversation" (hides it; the run goes on under its status-bar item) that takes the focus when
 * it appears, as the author opened it. Escape is the screen's own (Stop while running, Close
 * after), kept from the window it replaces. It never covers the editor: the editor stays usable
 * beside it the whole time.
 *
 * In the big review dialog (F-7.12, a drop notification's Open) the same frame is a centred
 * window over everything, focus mode included: Escape and a click on the backdrop only hide it
 * (the run stays under its status-bar item), its button says "Back to writing", and the focus
 * goes back where it was (the editor) when it closes.
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
  const dialog = useContext(SideWorkPlaceContext) === 'dialog'
  const frame = useRef<HTMLElement>(null)
  // True while the focus is inside the frame; a deck mounting later takes the focus only then.
  const inside = useRef(true)
  const takesFocus = useCallback(() => inside.current, [])

  // Read at the first render, before the deck or the frame takes the focus: where the dialog
  // gives it back on closing.
  const [before] = useState(() => document.activeElement)

  useEffect(() => {
    // A deck already took the focus on mount (its effect runs first); otherwise the frame does.
    const el = frame.current
    if (el !== null && !el.contains(document.activeElement)) el.focus()
    if (!dialog) return
    return () => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (lost && before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [dialog, before])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (dialog) onHide()
    else onEscape()
  }

  const section = (
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
      role={dialog ? 'dialog' : undefined}
      aria-modal={dialog ? true : undefined}
      className={
        dialog
          ? 'flex max-h-[85vh] w-[860px] max-w-[95vw] flex-col overflow-y-auto rounded-lg border border-line bg-surface-raised pb-2 shadow-panel outline-none'
          : 'flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line outline-none'
      }
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
          {dialog ? 'Back to writing' : 'Back to the conversation'}
        </button>
      </div>
      <SideWorkFocus.Provider value={takesFocus}>{children}</SideWorkFocus.Provider>
    </section>
  )
  if (!dialog) return section
  return (
    <div
      data-testid="side-work-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onHide()
      }}
    >
      {section}
    </div>
  )
}
