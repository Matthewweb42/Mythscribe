/**
 * The MythScribe Cloud usage meter (F-15.5): the period the meter covers, the run-out projection,
 * and when the app warns. Pure, and imported by both the app and the Worker so "this period"
 * means the same window on each side.
 *
 * Credits are prepaid, so there is no billing cycle: the period is a rolling window. The hard
 * caps are not here: the Worker refuses at a balance at or below zero (F-15.3) and the app's
 * daily cap already prices Cloud requests at the Cloud rate (F-15.4).
 */

const DAY_MS = 24 * 60 * 60_000

/** The meter, the per-feature breakdown, and the projection all cover this many days. */
export const USAGE_PERIOD_DAYS = 30
export const USAGE_PERIOD_MS = USAGE_PERIOD_DAYS * DAY_MS
/** Below this balance (1.00 USD) the app warns, whatever the pace. */
export const LOW_BALANCE_MICROS = 1_000_000
/** The app warns when the balance lasts this many days or fewer at the period's pace. */
export const RUN_OUT_WARNING_DAYS = 3

/** Total spend over a set of per-feature rows, in micro-USD. */
export function periodSpentMicros(rows: readonly { micros: number }[]): number {
  return rows.reduce((sum, row) => sum + row.micros, 0)
}

export interface ProjectionInput {
  balanceMicros: number
  /** Spend inside the period. */
  spentMicros: number
  /** When the oldest charge inside the period was made (epoch ms); null with none. */
  firstChargeAt: number | null
  now: number
}

/**
 * Whole days the balance lasts at the period's pace; null when there is no spend to project
 * from. The pace is spend per day since the first charge in the period (at least one day, at
 * most the whole period), so an account that started three days ago is not averaged over thirty.
 */
export function projectedDaysLeft(input: ProjectionInput): number | null {
  if (input.balanceMicros <= 0) return 0
  if (input.spentMicros <= 0 || input.firstChargeAt === null) return null
  const elapsedDays = Math.ceil((input.now - input.firstChargeAt) / DAY_MS)
  const activeDays = Math.min(USAGE_PERIOD_DAYS, Math.max(1, elapsedDays))
  return Math.floor(input.balanceMicros / (input.spentMicros / activeDays))
}

export type CreditWarning = 'empty' | 'low' | 'runOut'

/** The one soft warning to show, most urgent first; null while the balance is comfortable. */
export function creditWarning(input: {
  balanceMicros: number
  daysLeft: number | null
}): CreditWarning | null {
  if (input.balanceMicros <= 0) return 'empty'
  if (input.balanceMicros < LOW_BALANCE_MICROS) return 'low'
  if (input.daysLeft !== null && input.daysLeft <= RUN_OUT_WARNING_DAYS) return 'runOut'
  return null
}
