import { asc, count, eq, inArray, sql } from 'drizzle-orm'
import type { JudgeVerdict } from '@shared/memory/findings'
import { sha256 } from '../../ai/request'
import { verdictCache, type VerdictCacheRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The judge's verdicts remembered (F-16.27; plan P4 §1.1, §2.3): one row per pair-order judged,
 * keyed by a hash of the prompt version, the tier, the order and the pair as sent (with scene
 * numbers masked and names folded, slice 2), so the same words are never judged twice, whatever the
 * draft, a scene move or a Rename in book. Not per draft. Bounded: an insert past
 * `VERDICT_CACHE_MAX` rows prunes the least recently used.
 */

export const VERDICT_CACHE_MAX = 5_000

/** The order a pair was sent in: as found (A, B), or swapped (B, A). */
export type PairOrder = 'ab' | 'ba'

/** A pair-order's cache key: the prompt version, the tier, the order and the item as sent. */
export function verdictKey(parts: {
  promptVersion: string
  tier: string
  order: PairOrder
  item: string
}): string {
  return sha256([parts.promptVersion, parts.tier, parts.order, parts.item].join('\u0000'))
}

/** A remembered verdict. */
export interface CachedVerdict {
  verdict: JudgeVerdict
  why: string | null
  model: string
  costUsd: number
}

/** The verdict remembered for `key`, marking it used now; null when the pair-order was never judged. */
export function cachedVerdict(db: TreeDb, key: string, now: Date): CachedVerdict | null {
  const row = db.select().from(verdictCache).where(eq(verdictCache.key, key)).get()
  if (row === undefined) return null
  db.update(verdictCache).set({ used: now.toISOString() }).where(eq(verdictCache.key, key)).run()
  return { verdict: row.verdict, why: row.why, model: row.model, costUsd: row.costUsd }
}

/**
 * The verdict remembered for `key` without marking it used (a price worked out before anything is
 * sent reads the cache and must not write); null when the pair-order was never judged.
 */
export function peekVerdict(db: TreeDb, key: string): CachedVerdict | null {
  const row = db.select().from(verdictCache).where(eq(verdictCache.key, key)).get()
  return row === undefined
    ? null
    : { verdict: row.verdict, why: row.why, model: row.model, costUsd: row.costUsd }
}

/** Remembers a verdict (replacing one under the same key), then prunes to the newest `max` by use. */
export function cacheVerdict(
  db: TreeDb,
  row: Omit<VerdictCacheRow, 'created' | 'used'>,
  now: Date,
  max = VERDICT_CACHE_MAX
): void {
  const at = now.toISOString()
  db.transaction((tx) => {
    tx.insert(verdictCache)
      .values({ ...row, created: at, used: at })
      .onConflictDoUpdate({
        target: verdictCache.key,
        set: {
          verdict: row.verdict,
          why: row.why,
          tier: row.tier,
          promptVersion: row.promptVersion,
          model: row.model,
          costUsd: row.costUsd,
          used: at
        }
      })
      .run()
    const total = tx.select({ n: count() }).from(verdictCache).get()?.n ?? 0
    if (total <= max) return
    const oldest = tx
      .select({ key: verdictCache.key })
      .from(verdictCache)
      .orderBy(asc(verdictCache.used), sql`rowid`)
      .limit(total - max)
      .all()
      .map((each) => each.key)
    if (oldest.length > 0) tx.delete(verdictCache).where(inArray(verdictCache.key, oldest)).run()
  })
}
