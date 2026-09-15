import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { AI_DATA_SHARING } from '@shared/aiSettings'
import { useAiActivityStore } from './aiActivityStore'

/** How long a request must be in flight before the indicator shows, so a cache hit never flickers it. */
export const AI_ACTIVITY_DELAY_MS = 300

/**
 * The one in-flight indicator for every AI feature (F-5.10), in the header beside the
 * Assistant toggle: a spinner and the running features' labels from the data-sharing
 * registry, as `role="status"`. Nothing renders while nothing is in flight; a busy spell
 * shorter than `AI_ACTIVITY_DELAY_MS` (a cache hit) never shows at all, and once shown the
 * indicator stays up until the last request has settled, however young that request is.
 */
export function AiActivityIndicator(): React.JSX.Element | null {
  const labels = useAiActivityStore(
    useShallow((s) => {
      const seen = new Set<string>()
      for (const { feature } of Object.values(s.inflight)) seen.add(AI_DATA_SHARING[feature].label)
      return [...seen]
    })
  )
  const busySince = useAiActivityStore((s) => s.busySince)
  /** The busy spell the delay has elapsed for; the indicator shows while that spell is the current one. */
  const [shownFor, setShownFor] = useState<number | null>(null)

  useEffect(() => {
    if (busySince === null) return
    const wait = Math.max(0, AI_ACTIVITY_DELAY_MS - (Date.now() - busySince))
    const timer = setTimeout(() => setShownFor(busySince), wait)
    return () => clearTimeout(timer)
  }, [busySince])

  if (busySince === null || shownFor !== busySince || labels.length === 0) return null
  return (
    <span
      role="status"
      aria-label="AI activity"
      data-testid="ai-activity"
      className="flex items-center gap-1.5 text-xs text-fg-muted"
    >
      <Loader2 size={14} aria-hidden="true" className="animate-spin" />
      <span>{labels.join(', ')}</span>
    </span>
  )
}
