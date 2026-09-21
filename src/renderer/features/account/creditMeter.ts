import { MICROS_PER_USD } from '@shared/cloudRates'
import type { CreditWarning } from '@shared/cloudUsage'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/**
 * The words of the Cloud usage meter (F-15.5), in one place so the status-bar notice and the
 * Account tab say the same thing about the same balance. The numbers themselves come from
 * `@shared/cloudUsage`; nothing here decides when to warn.
 */

/** The one line a warning gets, wherever it is shown. */
export function creditWarningText(
  warning: CreditWarning,
  input: { balanceMicros: number; daysLeft: number | null }
): string {
  if (warning === 'empty') return 'Cloud credits used up'
  if (warning === 'low')
    return `Cloud credits low: ${formatUsd(input.balanceMicros / MICROS_PER_USD)}`
  return `Cloud credits: about ${formatCount(input.daysLeft ?? 0, 'day')} left`
}

/** The projection under the period's spend: how long the balance lasts at this pace. */
export function runOutText(daysLeft: number | null): string {
  if (daysLeft === null) return 'Not enough usage to project yet'
  if (daysLeft <= 0) return 'Used up'
  return `About ${formatCount(daysLeft, 'day')} left at this pace`
}
