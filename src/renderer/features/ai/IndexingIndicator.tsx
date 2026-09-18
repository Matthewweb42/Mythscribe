import { Loader2 } from 'lucide-react'
import { useIndexingStore } from './indexingStore'

const BUTTON = 'rounded-md border border-line px-1.5 py-0.5 hover:bg-surface'

/**
 * The background index queue's one line in the header (F-5.13), beside the AI activity
 * indicator: "Indexing 3 of 12 scenes" while the queue works, why it stopped when it paused on
 * a failure only the author can fix, and how many scenes gave up after their retries. Nothing
 * renders while nothing is queued, running, or failed, so a manuscript that is up to date shows
 * no chrome at all. Cancel is always there while it shows; Retry appears when the queue is
 * waiting on the author.
 */
export function IndexingIndicator(): React.JSX.Element | null {
  const status = useIndexingStore((s) => s.status)
  const cancel = useIndexingStore((s) => s.cancel)
  const resume = useIndexingStore((s) => s.resume)
  const { queued, running, failed, done, paused } = status

  if (queued === 0 && running === null && failed === 0 && paused === null) return null

  // Nothing is moving: either the queue is paused, or what is left of it gave up.
  const stalled = paused !== null || (failed > 0 && running === null && queued === 0)
  const total = done + queued + failed + (running === null ? 0 : 1)
  const at = done + (running === null ? 0 : 1)
  const text =
    paused !== null
      ? `Indexing paused · ${paused.message}`
      : stalled
        ? `${failed} ${failed === 1 ? 'scene' : 'scenes'} could not be summarised`
        : `Indexing ${at} of ${total} scenes`

  return (
    <span
      role="status"
      aria-label="Indexing"
      data-testid="indexing"
      title={paused?.nextStep}
      className="flex items-center gap-1.5 text-xs text-fg-muted"
    >
      {stalled ? null : <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
      <span>{text}</span>
      {stalled ? (
        <button
          type="button"
          data-testid="indexing-resume"
          onClick={() => void resume()}
          className={BUTTON}
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Cancel indexing"
        data-testid="indexing-cancel"
        onClick={() => void cancel()}
        className={BUTTON}
      >
        Cancel
      </button>
    </span>
  )
}
