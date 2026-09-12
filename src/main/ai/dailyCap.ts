import { z } from 'zod'
import { DEFAULT_DAILY_CAP_USD, DailyCapUsd } from '@shared/ai'

/**
 * The app-wide daily spend cap and the day's tally (F-5.14), stored in `app-state.json` so
 * every project opened today spends against one cap. Pure functions over the state: the
 * `AppStateStore` supplies persistence, and the request path (`request.ts`) calls `spend`
 * after every completed request. Days are the author's local calendar days (`dayOf`), so
 * "wait until tomorrow" means what it says on the clock.
 */
export const AiUsageState = z.object({
  dailyCapUsd: DailyCapUsd.default(DEFAULT_DAILY_CAP_USD),
  /** The local day (`YYYY-MM-DD`) the tally belongs to; null before the first request. */
  spentDate: z.string().nullable().default(null),
  spentTodayUsd: z.number().min(0).default(0),
  requestsToday: z.number().int().min(0).default(0),
  tokensToday: z.number().int().min(0).default(0)
})
export type AiUsageState = z.infer<typeof AiUsageState>

export function defaultAiUsageState(): AiUsageState {
  return {
    dailyCapUsd: DEFAULT_DAILY_CAP_USD,
    spentDate: null,
    spentTodayUsd: 0,
    requestsToday: 0,
    tokensToday: 0
  }
}

/** The local calendar day of `now` as `YYYY-MM-DD`. */
export function dayOf(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The state for `today`: the same one, or a fresh tally when the stored day is another. */
export function rollIfNewDay(state: AiUsageState, today: string): AiUsageState {
  if (state.spentDate === today) return state
  return { ...state, spentDate: today, spentTodayUsd: 0, requestsToday: 0, tokensToday: 0 }
}

/** What one completed request adds to the day. */
export interface Spend {
  costUsd: number
  tokens: number
}

/** The state after one request on `today` (rolling the day first). */
export function spend(state: AiUsageState, amount: Spend, today: string): AiUsageState {
  const day = rollIfNewDay(state, today)
  return {
    ...day,
    spentTodayUsd: day.spentTodayUsd + amount.costUsd,
    requestsToday: day.requestsToday + 1,
    tokensToday: day.tokensToday + amount.tokens
  }
}

/** True when spending `usd` on `today` would take the tally over the cap (reaching it exactly is allowed). */
export function wouldExceed(state: AiUsageState, usd: number, today: string): boolean {
  const day = rollIfNewDay(state, today)
  return day.spentTodayUsd + usd > day.dailyCapUsd
}
