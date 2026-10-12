import type { ContextEstimate } from '@shared/contextLibrary'
import { droppedLine, hasFilingConflict, type FilingReview } from '@shared/filing'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/** The estimate as one line (CLAUDE.md rule 10: cost is visible before anything is sent). */
export function filingEstimateLine(estimate: ContextEstimate): string {
  const requests = formatCount(estimate.chunks, 'request')
  const tokens = `≈ ${formatCount(estimate.tokensIn)} tokens in, ${formatCount(estimate.tokensOut)} out`
  const model = estimate.model === '' ? 'the strong model' : estimate.model
  const cost = estimate.priced
    ? `about ${formatUsd(estimate.costUsd)}`
    : 'cost unknown for this model'
  return `${requests} to ${model} · ${tokens} · ${cost}`
}

/** What the filing would do, as the review's header line. */
export function filingSummaryLine(review: FilingReview): string {
  const created = review.items.filter((item) => item.recordId === null).length
  const added = review.items.length - created
  const conflicts = review.items.filter(hasFilingConflict).length
  const parts = [formatCount(created, 'new record'), `${formatCount(added, 'record')} added to`]
  if (conflicts > 0) parts.push(formatCount(conflicts, 'conflict'))
  const dropped = droppedLine(review.dropped)
  return dropped === null ? parts.join(' · ') : `${parts.join(' · ')} · ${dropped}`
}
