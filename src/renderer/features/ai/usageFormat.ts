import type { UsageTotals } from '@shared/ai'

/** Two decimals, with a floor so a fraction of a cent never reads as free. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`

/** A thousands-grouped count, with the unit pluralized when one is given. */
export const formatCount = (n: number, unit?: string): string => {
  const digits = n.toLocaleString('en-US')
  return unit === undefined ? digits : `${digits} ${unit}${n === 1 ? '' : 's'}`
}

/** One line for a totals row: cost, requests, tokens. */
export const describeTotals = (t: UsageTotals): string =>
  `${formatUsd(t.costUsd)} · ${formatCount(t.requests, 'request')} · ${formatCount(t.tokens, 'token')}`
