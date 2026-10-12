import { z } from 'zod'
import type { AiFeatureId } from '@shared/ai'
import type { CreditsResult } from '@shared/cloudApi'
import {
  CLOUD_CAP_DEFAULT_USD,
  CLOUD_CAP_EXTRA_USD,
  CloudCapUsd,
  type CloudCapState
} from '@shared/memory/cloudCap'

/**
 * Story memory v2's Cloud monthly tally (F-16.19; plan P2a §3.6), stored in `app-state.json` as
 * `memoryCloud` so every project on this machine spends against one cap, like the daily cap
 * (`dailyCap.ts`). Pure functions over the state: the reader service supplies persistence and
 * adds each Cloud reading's reported cost to `backgroundUsd` (unasked) or `askedUsd` (the author
 * started it or confirmed its price, P2a-D9). Background reading stops at `capUsd + extraUsd`;
 * asked work never does. Months are the author's local calendar months (`monthOf`). The tally is
 * raised, never lowered, to what the server says this account spent on reading this month
 * (`reconcileTally`, P2a-D10), so another machine on the same account is counted too.
 */

export const MemoryCloudState = z.object({
  /** The local month (`YYYY-MM`) the tally belongs to; null before the first Cloud reading. */
  month: z.string().nullable().default(null),
  backgroundUsd: z.number().min(0).default(0),
  askedUsd: z.number().min(0).default(0),
  /** What *Allow another $1 this month* added this month. */
  extraUsd: z.number().min(0).default(0),
  capUsd: CloudCapUsd.default(CLOUD_CAP_DEFAULT_USD),
  /** The month the "reached your cap" notice was raised in: once a month. */
  noticeMonth: z.string().nullable().default(null)
})
export type MemoryCloudState = z.infer<typeof MemoryCloudState>

export function defaultMemoryCloudState(): MemoryCloudState {
  return {
    month: null,
    backgroundUsd: 0,
    askedUsd: 0,
    extraUsd: 0,
    capUsd: CLOUD_CAP_DEFAULT_USD,
    noticeMonth: null
  }
}

/** The features whose Cloud spend is story memory reading (the server's `periodSpend` rows). */
export const MEMORY_CLOUD_FEATURES: readonly AiFeatureId[] = ['reader', 'verify']

/** The local calendar month of `now` as `YYYY-MM`. */
export function monthOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** The state for `month`: the same one, or a fresh tally (the cap kept) when it is another. */
export function rollIfNewMonth(state: MemoryCloudState, month: string): MemoryCloudState {
  if (state.month === month) return state
  return { ...state, month, backgroundUsd: 0, askedUsd: 0, extraUsd: 0 }
}

/** The state after one Cloud request's reported cost, background or asked. */
export function addCloudSpend(
  state: MemoryCloudState,
  spend: { usd: number; asked: boolean },
  month: string
): MemoryCloudState {
  const current = rollIfNewMonth(state, month)
  const usd = Math.max(0, spend.usd)
  return spend.asked
    ? { ...current, askedUsd: current.askedUsd + usd }
    : { ...current, backgroundUsd: current.backgroundUsd + usd }
}

/** Where background reading stops this month. */
export function cloudLimit(state: MemoryCloudState, month: string): number {
  const current = rollIfNewMonth(state, month)
  return current.capUsd + current.extraUsd
}

/** True once background reading has spent the month's cap (and any extra allowed). */
export function capReached(state: MemoryCloudState, month: string): boolean {
  const current = rollIfNewMonth(state, month)
  return current.backgroundUsd >= cloudLimit(current, month)
}

/** *Allow another $1 this month*. */
export function allowMore(state: MemoryCloudState, month: string): MemoryCloudState {
  const current = rollIfNewMonth(state, month)
  return { ...current, extraUsd: current.extraUsd + CLOUD_CAP_EXTRA_USD }
}

/** *Change the cap* (Settings): the extra allowed this month stays. */
export function setCap(state: MemoryCloudState, capUsd: number, month: string): MemoryCloudState {
  return { ...rollIfNewMonth(state, month), capUsd: CloudCapUsd.parse(capUsd) }
}

/** Whether this month's cap notice is still to be raised. */
export function capNoticeDue(state: MemoryCloudState, month: string): boolean {
  return state.noticeMonth !== month
}

export function markCapNotice(state: MemoryCloudState, month: string): MemoryCloudState {
  return { ...rollIfNewMonth(state, month), noticeMonth: month }
}

/**
 * Raises the month's background tally to the server's reading spend (P2a-D10): the `reader` and
 * `verify` rows of `/credits`'s rolling period, less what this machine counted as asked, but only
 * when the period's oldest charge falls inside this month (the period is not a calendar month, so
 * otherwise its figure holds last month's spend). Never lowers the tally.
 */
export function reconcileTally(
  state: MemoryCloudState,
  credits: Pick<CreditsResult, 'periodSpend' | 'periodFirstChargeAt'>,
  now: Date
): MemoryCloudState {
  const month = monthOf(now)
  const current = rollIfNewMonth(state, month)
  if (credits.periodFirstChargeAt === null) return current
  if (monthOf(new Date(credits.periodFirstChargeAt)) !== month) return current
  const serverMicros = credits.periodSpend
    .filter((row) => (MEMORY_CLOUD_FEATURES as readonly string[]).includes(row.feature))
    .reduce((sum, row) => sum + row.micros, 0)
  const background = serverMicros / 1_000_000 - current.askedUsd
  return background > current.backgroundUsd ? { ...current, backgroundUsd: background } : current
}

/** What `cloudCap:get` answers. */
export function cloudCapState(state: MemoryCloudState, month: string): CloudCapState {
  const current = rollIfNewMonth(state, month)
  const limitUsd = cloudLimit(current, month)
  return {
    month,
    capUsd: current.capUsd,
    extraUsd: current.extraUsd,
    backgroundUsd: current.backgroundUsd,
    askedUsd: current.askedUsd,
    limitUsd,
    reached: current.backgroundUsd >= limitUsd
  }
}
