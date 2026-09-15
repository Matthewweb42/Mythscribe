import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Logo } from '@renderer/features/shell/Logo'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

interface AboutDialogProps {
  onClose: () => void
}

/** The one-line description, as `package.json` has it. */
export const ABOUT_TAGLINE = 'Local-first novel writing with AI that keeps your voice.'

/**
 * Help › About (F-7.1): the mark, the name, the version main reports through `app:info`, and
 * the tagline. A modal like the Settings dialog: Escape, OK, and a click on the backdrop close
 * it; the focus starts on OK.
 */
export function AboutDialog({ onClose }: AboutDialogProps): React.JSX.Element {
  const titleId = useId()
  const okButton = useRef<HTMLButtonElement>(null)
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    okButton.current?.focus()
    let cancelled = false
    ipc()
      .invoke('app:info', undefined)
      .then((info) => {
        if (!cancelled) setVersion(info.version)
      })
      .catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      cancelled = true
    }
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
        className="flex w-[360px] max-w-[90vw] flex-col items-center gap-3 rounded-lg border border-line bg-surface-raised px-6 py-6 text-center shadow-panel"
      >
        <Logo size={64} />
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          About MythScribe
        </h2>
        <p className="m-0 text-sm text-fg-muted" data-testid="about-version">
          {version === null ? 'Version …' : `Version ${version}`}
        </p>
        <p className="m-0 text-sm">{ABOUT_TAGLINE}</p>
        <button
          ref={okButton}
          type="button"
          onClick={onClose}
          className="mt-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          OK
        </button>
      </div>
    </div>
  )
}
