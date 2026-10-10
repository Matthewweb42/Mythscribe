import { X } from 'lucide-react'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import type { ActivityNote } from './activityJobs'
import { openNote, retryNote } from './activityRoutes'
import { useActivityStore } from './activityStore'

const BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface disabled:opacity-60'
const PRIMARY =
  'rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-hover'
const DANGER =
  'rounded-md bg-danger px-2 py-0.5 text-xs font-medium text-danger-fg hover:opacity-90'

/**
 * The finished / failed notifications of the long jobs (F-7.12), dropped down from the top
 * centre, under the header (at the window's top in focus mode). Each says what finished ("Organise
 * is ready to review", "Edit pass finished") with Open and ×; a failure is in the danger colour
 * with its reason and Retry where the job can run again. Outside focus mode they stay until
 * opened or dismissed; in focus mode one shows for a few seconds, then waits for focus mode to
 * end (`activityStore` parks it). The × is "Dismiss notification", like the toasts'.
 */
export function ActivityDrops(): React.JSX.Element | null {
  const notes = useActivityStore((s) => s.notes)
  const focus = useFocusStore((s) => s.active)
  const shown = notes.filter((note) => !note.parked)
  if (shown.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="activity-drops"
      className={`pointer-events-none fixed left-1/2 z-40 flex w-[420px] max-w-[90vw] -translate-x-1/2 flex-col gap-2 ${focus ? 'top-3' : 'top-12'}`}
    >
      {shown.map((note) => (
        <Drop key={note.id} note={note} />
      ))}
    </div>
  )
}

function Drop({ note }: { note: ActivityNote }): React.JSX.Element {
  const dismiss = useActivityStore((s) => s.dismiss)
  const failed = note.status === 'failed'
  return (
    <div
      data-testid="activity-drop"
      data-kind={note.kind}
      data-status={note.status}
      className={`activity-drop pointer-events-auto flex items-start gap-3 rounded-md border border-l-4 bg-surface-raised px-3 py-2 text-sm shadow-panel ${failed ? 'border-danger' : 'border-line border-l-accent'}`}
    >
      <div className="min-w-0 flex-1">
        <p className={`m-0 font-medium ${failed ? 'text-danger' : ''}`}>{note.title}</p>
        {note.detail !== null && note.detail !== '' ? (
          <p className="mt-0.5 mb-0 text-xs text-fg-muted">{note.detail}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {note.canRetry ? (
          <button type="button" onClick={() => void retryNote(note)} className={DANGER}>
            Retry
          </button>
        ) : null}
        {note.canOpen ? (
          <button
            type="button"
            onClick={() => void openNote(note)}
            className={failed ? BUTTON : PRIMARY}
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismiss(note.id)}
          className="text-fg-muted hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
