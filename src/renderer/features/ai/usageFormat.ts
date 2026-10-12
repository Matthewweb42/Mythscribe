import { AiFeatureId, type AiUsage, type UsageTotals } from '@shared/ai'
import { AI_DATA_SHARING } from '@shared/aiSettings'
import { currentAssistantName } from '@renderer/features/shell/viewStore'
import { nameAssistant } from '@shared/assistantName'

/**
 * The author-facing name of one AI feature, from the data-sharing table (F-14.4), with the
 * assistant called by its name (F-7.13). Shared by the AI tab's ledger (F-5.14) and the Account
 * tab's Cloud spend (F-15.3); a ledger key from a newer build shows as itself rather than
 * blanking the row.
 */
export const featureLabel = (
  feature: string,
  assistantName: string = currentAssistantName()
): string => {
  const parsed = AiFeatureId.safeParse(feature)
  return parsed.success ? nameAssistant(AI_DATA_SHARING[parsed.data].label, assistantName) : feature
}

/** Two decimals, with a floor so a fraction of a cent never reads as free. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`

/**
 * A small sum the way story memory's footer and prices say it (F-16.16, F-16.19): cents under a
 * dollar ("0.09¢", "0.3¢", "12¢"), a floor so a fraction never reads as free ("<0.01¢"), and
 * dollars from one ("$1", "$1.25").
 */
export const formatCents = (usd: number): string => {
  if (usd <= 0) return '0¢'
  const cents = usd * 100
  // Rounded to the cent first, so $0.996 reads "$1" (never "100¢") and $1.004 reads "$1".
  const whole = Math.round(cents)
  if (whole >= 100) {
    return whole % 100 === 0 ? `$${whole / 100}` : `$${(whole / 100).toFixed(2)}`
  }
  if (cents < 0.01) return '<0.01¢'
  if (cents < 0.1) return `${Number(cents.toFixed(2))}¢`
  if (cents < 10) return `${Number(cents.toFixed(1))}¢`
  return `${whole}¢`
}

/** One request's cost (F-4.7's note): four decimals, since a single fast-tier call is well under a cent. */
export const formatRequestCost = (usd: number): string =>
  usd > 0 && usd < 0.00005 ? '<$0.0001' : `$${usd.toFixed(4)}`

/** A thousands-grouped count, with the unit pluralized when one is given. */
export const formatCount = (n: number, unit?: string): string => {
  const digits = n.toLocaleString('en-US')
  return unit === undefined ? digits : `${digits} ${unit}${n === 1 ? '' : 's'}`
}

/**
 * One line for a totals row: cost, requests, tokens. `showTokens` is false for MythScribe Cloud
 * (AI-BILLING-SPEC C4: hosted users see dollars; tokens stay in the usage history).
 */
export const describeTotals = (t: UsageTotals, showTokens = true): string =>
  `${formatUsd(t.costUsd)} · ${formatCount(t.requests, 'request')}${showTokens ? ` · ${formatCount(t.tokens, 'token')}` : ''}`

/**
 * The line under every AI answer (F-5.9, CLAUDE.md rule 10): the model, what the request cost,
 * its tokens in and out, and whether it came from the local cache. `usage` is null only for a
 * chat turn stored before F-5.9, whose tokens were never kept; then the token part is left out
 * rather than shown as zero. `showTokens` is false for MythScribe Cloud (AI-BILLING-SPEC C4:
 * hosted users see dollars; tokens stay in the usage history); `RequestCost` decides it.
 */
export const describeRequest = (
  request: {
    model: string
    costUsd: number
    usage: AiUsage | null
    cached: boolean
  },
  showTokens = true
): string => {
  const tokens =
    request.usage === null || !showTokens
      ? ''
      : ` · ${formatCount(request.usage.inputTokens)} in · ${formatCount(request.usage.outputTokens)} out`
  return `${request.model} · ${formatRequestCost(request.costUsd)}${tokens}${request.cached ? ' · cached' : ''}`
}
