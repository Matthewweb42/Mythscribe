import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

interface StatsFrameProps {
  title: string
  /** Width classes of the dialog box, e.g. `w-[560px]`. */
  widthClassName: string
  onClose: () => void
  children: ReactNode
}

/**
 * The modal frame the statistics dialogs share (F-10.4 word count, F-10.5 dashboard): a backdrop
 * that closes on a click outside, a `role="dialog"` named by its heading, Escape to close, and a
 * Close button that takes the focus when it opens.
 */
export function StatsFrame({
  title,
  widthClassName,
  onClose,
  children
}: StatsFrameProps): React.JSX.Element {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className={`flex max-h-[90vh] max-w-[94vw] flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-raised px-5 py-4 shadow-panel ${widthClassName}`}
      >
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          {title}
        </h2>
        {children}
        <div className="flex justify-end">
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
