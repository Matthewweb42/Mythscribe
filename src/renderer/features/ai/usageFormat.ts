import type { AiUsage, UsageTotals } from '@shared/ai'

/** Two decimals, with a floor so a fraction of a cent never reads as free. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`

/** One request's cost (F-4.7's note): four decimals, since a single fast-tier call is well under a cent. */
export const formatRequestCost = (usd: number): string =>
  usd > 0 && usd < 0.00005 ? '<$0.0001' : `$${usd.toFixed(4)}`

/** A thousands-grouped count, with the unit pluralized when one is given. */
export const formatCount = (n: number, unit?: string): string => {
  const digits = n.toLocaleString('en-US')
  return unit === undefined ? digits : `${digits} ${unit}${n === 1 ? '' : 's'}`
}

/** One line for a totals row: cost, requests, tokens. */
export const describeTotals = (t: UsageTotals): string =>
  `${formatUsd(t.costUsd)} · ${formatCount(t.requests, 'request')} · ${formatCount(t.tokens, 'token')}`

/**
 * The line under every AI answer (F-5.9, CLAUDE.md rule 10): the model, what the request cost,
 * its tokens in and out, and whether it came from the local cache. `usage` is null only for a
 * chat turn stored before F-5.9, whose tokens were never kept; then the token part is left out
 * rather than shown as zero.
 */
export const describeRequest = (request: {
  model: string
  costUsd: number
  usage: AiUsage | null
  cached: boolean
}): string => {
  const tokens =
    request.usage === null
      ? ''
      : ` · ${formatCount(request.usage.inputTokens)} in · ${formatCount(request.usage.outputTokens)} out`
  return `${request.model} · ${formatRequestCost(request.costUsd)}${tokens}${request.cached ? ' · cached' : ''}`
}
