import type { KeyboardEvent, ReactNode } from 'react'
import { X } from 'lucide-react'

export interface SearchFrameProps {
  /** The id the heading gets; the dialog is labelled by it. */
  titleId: string
  title: string
  testId: string
  /** The accessible name of the close button. */
  closeLabel: string
  onClose: () => void
  /** Keys the dialog handles beyond Escape (which always closes). */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** Sits in the header, before the close button. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * The frame the project search (F-10.1) and find and replace (F-10.2) share: a command-palette
 * style modal near the top of the window, with a title row and a close button. Escape, the close
 * button, and a press on the backdrop close it; everything under the title row is the caller's.
 */
export function SearchFrame({
  titleId,
  title,
  testId,
  closeLabel,
  onClose,
  onKeyDown,
  actions,
  children
}: SearchFrameProps): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else {
            onKeyDown?.(event)
          }
        }}
        className="flex max-h-[70vh] w-[640px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h2 id={titleId} className="m-0 text-sm font-semibold">
            {title}
          </h2>
          <div className="flex items-center gap-1">
            {actions}
            <button
              type="button"
              aria-label={closeLabel}
              title="Close"
              onClick={onClose}
              className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The text inputs of both dialogs. */
export const SEARCH_INPUT_CLASS =
  'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent'
