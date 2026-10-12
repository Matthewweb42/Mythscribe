import { useEffect, useId, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useDismissedStore } from './dismissedStore'
import { DISMISSED_KIND_LABEL } from './thisSceneView'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'

const dateOf = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * The one Dismissed list (F-16.10, answer 22; story memory v2), opened from the This scene
 * panel's footer: every "never bring this back" newest first, with its kind, what it was about,
 * the words and the date, and *Undo* on every row (the tombstone goes, so the thing may come
 * back: a mention is found again, a question asked again). Mounted in the project screen; open
 * while the dismissed store says so.
 */
export function DismissedDialog(): React.JSX.Element | null {
  const open = useDismissedStore((s) => s.open)
  if (!open) return null
  return <DismissedList />
}

function DismissedList(): React.JSX.Element {
  const titleId = useId()
  const items = useDismissedStore((s) => s.items)
  const [busy, setBusy] = useState<string | null>(null)
  const close = (): void => useDismissedStore.getState().setOpen(false)

  useEffect(() => {
    // The list as main holds it now (a roster change may have written rows meanwhile).
    useDismissedStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close()
  }
  const undo = async (id: string): Promise<void> => {
    if (busy !== null) return
    setBusy(id)
    try {
      await useDismissedStore.getState().undo(id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[80vh] w-[520px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          Dismissed ({items.length})
        </h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          What you said never to bring back. Undo lets it come back.
        </p>
        {items.length === 0 ? (
          <p className="m-0 mt-4 text-sm text-fg-muted">Nothing is dismissed.</p>
        ) : (
          <ul className="m-0 mt-3 min-h-0 flex-1 list-none overflow-y-auto p-0">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-2 border-b border-line py-2 text-sm last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-xs text-fg-muted">
                    {DISMISSED_KIND_LABEL[item.kind]} · {dateOf(item.created)}
                  </p>
                  <p className="m-0">{item.label}</p>
                  {item.quote === null || item.quote === item.label ? null : (
                    <p className="m-0 text-xs text-fg-muted">“{item.quote}”</p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`Undo: ${item.label}`}
                  disabled={busy !== null}
                  onClick={() => void undo(item.id)}
                  className={BUTTON}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={close} className={BUTTON}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
