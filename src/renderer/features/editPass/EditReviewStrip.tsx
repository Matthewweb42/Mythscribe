import { useCallback, useMemo } from 'react'
import { FixDiff, OffVoiceFlag } from '@renderer/features/editor/FixDiff'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import type {
  ReviewDecision,
  ReviewDeckGroup,
  ReviewDeckItem
} from '@renderer/features/review/reviewDeckModel'
import { useEditPassStore, type EditReviewSession } from './editPassStore'

/** A tracked change on the deck: still to decide (or kept for later), or settled by main. */
function itemOf(review: EditReviewSession, index: number): ReviewDeckItem | null {
  const change = review.changes[index]
  if (change === undefined) return null
  if (change.status === 'pending') {
    return {
      id: change.id,
      group: change.nodeId,
      decision: review.skipped.includes(change.id) ? 'skipped' : 'pending'
    }
  }
  return {
    id: change.id,
    group: change.nodeId,
    decision: change.status === 'accepted' ? 'accepted' : 'rejected',
    settled: true
  }
}

const SETTLED_TEXT = {
  accepted: 'Accepted: in the text now.',
  rejected: 'Rejected.',
  stale: 'Out of date: the passage changed since the pass.'
} as const

/**
 * Edit passes one change at a time (F-14.15, 2026-10-08): the review deck as a strip above the
 * editor of the change's scene. The editor jumps to each change (the change highlighted, the
 * keyboard left on the deck); A accepts it into the text at once (as the inline Accept does),
 * S keeps it for later, R rejects it, ← → step, and the scenes are the deck's groups (Accept
 * group takes a whole scene). The strip follows the review from scene to scene.
 */
export function EditReviewStrip(): React.JSX.Element | null {
  const review = useEditPassStore((s) => s.review)
  const busy = useEditPassStore((s) => s.busy)
  const items = useMemo(
    () =>
      review === null
        ? []
        : review.changes.flatMap((_, i) => {
            const item = itemOf(review, i)
            return item === null ? [] : [item]
          }),
    [review]
  )
  const groups = useMemo<ReviewDeckGroup[]>(() => {
    if (review === null) return []
    const ids = [...new Set(review.changes.map((change) => change.nodeId))]
    return ids.map((id) => ({ id, label: review.titles[id] ?? 'Scene', noun: 'Change' }))
  }, [review])
  const onCurrent = useCallback((id: string | null) => {
    useEditPassStore.getState().reviewAt(id)
  }, [])
  if (review === null) return null

  const decide = (ids: string[], decision: ReviewDecision): void => {
    const store = useEditPassStore.getState()
    const chosen = review.changes.filter((change) => ids.includes(change.id))
    if (decision === 'accepted') void store.accept(chosen)
    else if (decision === 'rejected') void store.reject(chosen)
    else if (decision === 'skipped') store.skipInReview(ids)
  }

  return (
    <div
      className="flex max-h-[55vh] shrink-0 flex-col border-b border-line bg-surface-raised"
      data-testid="edit-review"
    >
      <ReviewDeck
        label="Review tracked changes"
        items={items}
        groups={groups}
        initialId={review.currentId}
        renderCard={(id) => <ChangeCard id={id} />}
        onDecide={decide}
        reject
        skipLabel="Later"
        onCurrent={onCurrent}
        busy={busy}
        compact
        autoFocus
        actions={
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface"
            data-testid="edit-review-close"
            onClick={() => useEditPassStore.getState().endReview()}
          >
            Stop reviewing
          </button>
        }
      />
    </div>
  )
}

function ChangeCard({ id }: { id: string }): React.JSX.Element | null {
  const change = useEditPassStore((s) => s.review?.changes.find((c) => c.id === id) ?? null)
  if (change === null) return null
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="edit-review-change"
      data-status={change.status}
    >
      <FixDiff quote={change.original} fix={change.replacement ?? ''} testId="edit-review-diff" />
      {change.rationale ? <p className="m-0 text-sm text-fg-muted">{change.rationale}</p> : null}
      {change.flagged ? (
        <OffVoiceFlag violation={change.violation} testId="edit-review-flag" />
      ) : null}
      {change.status !== 'pending' ? (
        <p className="m-0 text-xs text-fg-muted">{SETTLED_TEXT[change.status]}</p>
      ) : null}
    </div>
  )
}
