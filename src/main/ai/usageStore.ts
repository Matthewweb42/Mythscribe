import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { asc, count, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { AiUsageSummary, UsageTotals } from '@shared/ai'
import type * as schema from '../db/schema'
import { aiUsage, type AiUsageInsert, type AiUsageRow } from '../db/schema'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type AiDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/** One completed request as the request path reports it; the id is minted here. */
export type UsageEntry = Omit<AiUsageInsert, 'id'>

/** The project's ledger halves of `AiUsageSummary`; the app-wide day comes from app state. */
export type LedgerSummary = Pick<AiUsageSummary, 'total' | 'byFeature'>

/** Appends one row to the ledger (F-5.14) and returns it. */
export function insertUsage(db: AiDb, entry: UsageEntry): AiUsageRow {
  const row: AiUsageInsert = { id: randomUUID(), ...entry }
  db.insert(aiUsage).values(row).run()
  return { cachedTokens: null, promptVersion: null, ...row }
}

/** Every row, oldest first (insertion order on a tie); for tests and later export. */
export function listUsage(db: AiDb): AiUsageRow[] {
  return db
    .select()
    .from(aiUsage)
    .orderBy(asc(aiUsage.at), asc(sql`rowid`))
    .all()
}

/**
 * The project's totals since it was created, and the same per feature (ordered by feature
 * name). One grouped query; the total is the sum of the groups. Cache hits count as requests
 * at zero tokens and cost, so the figures are what was spent, not what was avoided.
 */
export function ledgerSummary(db: AiDb): LedgerSummary {
  const byFeature = db
    .select({
      feature: aiUsage.feature,
      requests: count(),
      tokens: sql<number>`coalesce(sum(${aiUsage.promptTokens} + ${aiUsage.completionTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)`
    })
    .from(aiUsage)
    .groupBy(aiUsage.feature)
    .orderBy(asc(aiUsage.feature))
    .all()
  const total = byFeature.reduce<UsageTotals>(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      tokens: sum.tokens + row.tokens,
      costUsd: sum.costUsd + row.costUsd
    }),
    { requests: 0, tokens: 0, costUsd: 0 }
  )
  return { total, byFeature }
}
