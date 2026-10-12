import { Loader2 } from 'lucide-react'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { AI_WAIT_CLASS } from './aiWaitPhrases'
import { useIndexingStore } from './indexingStore'
import { indicatorText } from './indexingText'

const BUTTON = 'rounded-md border border-line px-1.5 py-0.5 hover:bg-surface'

/**
 * The background index queue's one line in the header (F-5.13), beside the AI activity
 * indicator: "Indexing 3 of 12 scenes" while the queue works, why it stopped when it paused on
 * a failure only the author can fix, and how many scenes gave up after their retries. Nothing
 * renders while nothing is queued, running, or failed, so a manuscript that is up to date shows
 * no chrome at all. Cancel is always there while it shows; Retry appears when the queue is
 * waiting on the author. In story memory v2 the queue is the reader's (F-16.16): "Reading 3 of 12
 * scenes", "2 scenes could not be read", "Reading paused · why".
 */
export function IndexingIndicator(): React.JSX.Element | null {
  const status = useIndexingStore((s) => s.status)
  const cancel = useIndexingStore((s) => s.cancel)
  const resume = useIndexingStore((s) => s.resume)
  const memory = useStoryMemory()
  const { queued, running, failed, paused } = status

  if (queued === 0 && running === null && failed === 0 && paused === null) return null

  // Nothing is moving: either the queue is paused, or what is left of it gave up.
  const stalled = paused !== null || (failed > 0 && running === null && queued === 0)
  const text = indicatorText(status, memory === 'v2' ? 'reading' : 'indexing')

  return (
    <span
      role="status"
      aria-label={memory === 'v2' ? 'Story memory reading' : 'Indexing'}
      data-testid="indexing"
      title={paused?.nextStep}
      className="flex items-center gap-1.5 text-xs text-fg-muted"
    >
      {stalled ? null : <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
      <span className={stalled ? undefined : AI_WAIT_CLASS}>{text}</span>
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
        aria-label={memory === 'v2' ? 'Stop reading' : 'Cancel indexing'}
        data-testid="indexing-cancel"
        onClick={() => void cancel()}
        className={BUTTON}
      >
        Cancel
      </button>
    </span>
  )
}
