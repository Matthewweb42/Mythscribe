import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { aiCache } from '../db/schema'
import type { CompletionUsage } from './providers/types'
import type { AiDb } from './usageStore'

/** The cache is bounded (CLAUDE.md, token efficiency rule 4); the oldest rows go first. */
export const AI_CACHE_MAX_ROWS = 500

const StoredUsage = z.object({ inputTokens: z.number(), outputTokens: z.number() })

export interface CachedResponse {
  text: string
  usage: CompletionUsage
}

export interface CacheEntry extends CachedResponse {
  /** The request path's own hash (feature, prompt version, model, context, messages). */
  key: string
  feature: string
  promptVersion: string | null
  model: string
  createdAt: string
}

/** The cached completion for `key`, or undefined on a miss (an unreadable row reads as a miss). */
export function getCached(db: AiDb, key: string): CachedResponse | undefined {
  const row = db.select().from(aiCache).where(eq(aiCache.contextHash, key)).get()
  if (!row) return undefined
  const usage = StoredUsage.safeParse(safeJson(row.usage))
  if (!usage.success) return undefined
  return { text: row.response, usage: usage.data }
}

/** Stores (or refreshes) one completion, then evicts the oldest rows beyond the bound. */
export function putCached(db: AiDb, entry: CacheEntry): void {
  db.insert(aiCache)
    .values({
      contextHash: entry.key,
      feature: entry.feature,
      promptVersion: entry.promptVersion,
      model: entry.model,
      response: entry.text,
      usage: JSON.stringify(entry.usage),
      createdAt: entry.createdAt
    })
    .onConflictDoUpdate({
      target: aiCache.contextHash,
      set: { response: entry.text, usage: JSON.stringify(entry.usage), createdAt: entry.createdAt }
    })
    .run()
  evictCache(db)
}

/** Deletes every row outside the newest `max` (by `created_at`, then key) and returns how many went. */
export function evictCache(db: AiDb, max = AI_CACHE_MAX_ROWS): number {
  return db.run(
    sql`DELETE FROM ${aiCache} WHERE ${aiCache.contextHash} NOT IN (
      SELECT ${aiCache.contextHash} FROM ${aiCache}
      ORDER BY ${aiCache.createdAt} DESC, ${aiCache.contextHash} DESC LIMIT ${max}
    )`
  ).changes
}

export function cacheSize(db: AiDb): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(aiCache)
      .get()?.n ?? 0
  )
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
