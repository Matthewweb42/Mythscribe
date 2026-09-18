import type { UsageTotals } from '@shared/ai'

/**
 * The session tally (F-5.9): what this run of the app has spent, across every project it
 * opened. In memory only — one object per app run, gone when the app quits — so it answers
 * "what has this sitting cost me?" where the ledger answers "what has this project cost me?"
 * and the daily cap answers "what has today cost me?". The request path calls `spend` beside
 * `dailyCap.spend`, so a cache hit counts as a request at zero cost exactly as it does there.
 */
export interface SessionUsage {
  totals(): UsageTotals
  spend(amount: { costUsd: number; tokens: number }): void
}

export function createSessionUsage(): SessionUsage {
  let requests = 0
  let tokens = 0
  let costUsd = 0
  return {
    totals: () => ({ requests, tokens, costUsd }),
    spend: (amount) => {
      requests += 1
      tokens += amount.tokens
      costUsd += amount.costUsd
    }
  }
}
