import type { PricingResult } from '@shared/cloudApi'
import { MICROS_PER_USD } from '@shared/cloudBilling'
import type { CreditWarning } from '@shared/cloudUsage'
import { WORD_COST_ACTIONS, wordsCovered } from '@shared/hostedPricing'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/**
 * The words of the Cloud usage meter (F-15.5), in one place so the status-bar notice and the
 * Account tab say the same thing about the same balance. The numbers themselves come from
 * `@shared/cloudUsage`; nothing here decides when to warn. AI-BILLING-SPEC: it is a balance in
 * dollars, never "credits".
 */

/** The one line a warning gets, wherever it is shown. */
export function creditWarningText(
  warning: CreditWarning,
  input: { balanceMicros: number; daysLeft: number | null }
): string {
  if (warning === 'empty') return 'MythScribe Cloud balance used up'
  if (warning === 'low')
    return `MythScribe Cloud balance low: ${formatUsd(input.balanceMicros / MICROS_PER_USD)}`
  return `MythScribe Cloud balance: about ${formatCount(input.daysLeft ?? 0, 'day')} left`
}

/** The projection under the period's spend: how long the balance lasts at this pace. */
export function runOutText(daysLeft: number | null): string {
  if (daysLeft === null) return 'Not enough usage to project yet'
  if (daysLeft <= 0) return 'Used up'
  return `About ${formatCount(daysLeft, 'day')} left at this pace`
}

/** E2: "about 140,000 words of line editing left"; null hides the line (no measured constant). */
export function wordsLeftText(words: number | null, action: string): string | null {
  return words === null ? null : `About ${formatCount(words, 'word')} of ${action} left`
}

/** The markup as the author reads it: 0.2 → "20%". */
const percent = (markup: number): string => `${Math.round(markup * 100)}%`

/** C2: hosted AI is a convenience, priced at cost plus the markup, never "credits". */
export function positioningText(pricing: PricingResult): string {
  return (
    'One balance in US dollars for every model, without an API key. Each request costs what the ' +
    `model's provider charges plus ${percent(pricing.markup)}, and nothing when you write without AI.`
  )
}

/** C3 (and S3): what the proxy keeps and what it never keeps, in plain words, beside the packs. */
export const PRIVACY_TEXT =
  'Your writing stays private. MythScribe Cloud passes each request to the AI model and back ' +
  'and never stores or logs your manuscript, your notes, your questions, or the answers. It ' +
  'keeps only your email address, your balance, and for each request the model, its size, its ' +
  'cost, and when it ran.'

/** The packs' terms: the balance never expires; refunds follow the configured window. */
export function termsText(pricing: PricingResult): string {
  const refund =
    pricing.refundWindowDays > 0
      ? ` Unused balance can be refunded within ${formatCount(pricing.refundWindowDays, 'day')} of buying it.`
      : ''
  return `Your balance never expires. Payment is handled by Lemon Squeezy.${refund}`
}

/** E3: what one pack covers on the default model; null (hidden) until the constants are measured. */
export function packExampleText(pricing: PricingResult, priceCents: number): string | null {
  const micros = priceCents * 10_000
  const parts = (Object.keys(WORD_COST_ACTIONS) as (keyof typeof WORD_COST_ACTIONS)[])
    .map((action) => {
      const words = wordsCovered(pricing, micros, action)
      return words === null ? null : `${formatCount(words, 'word')} of ${WORD_COST_ACTIONS[action]}`
    })
    .filter((part): part is string => part !== null)
  return parts.length === 0 ? null : `Covers about ${parts.join(', or ')}.`
}
