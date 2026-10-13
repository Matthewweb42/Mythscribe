import { randomUUID } from 'node:crypto'
import { count, desc, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  NAVIGATION_TERMS_MAX,
  SEARCH_MISS_MAX,
  SEARCH_MISS_QUESTION_MAX,
  SEARCH_MISS_QUOTE_MAX,
  SEARCH_MISSES_LIST_MAX,
  type SearchMisses,
  type SearchMissView
} from '@shared/scribe'
import { searchMiss, type SearchMissRow } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * Ms Scribe's search misses (F-16.25; P3-D15): the one writer of `search_miss` (migration 0037).
 * A miss is a passage a widened answer cited that the turn's searches had not returned; the log
 * is the trigger for meaning search with embeddings (F-16.35) and the count Settings shows. Local
 * and derived: nothing here is ever sent anywhere. The newest `SEARCH_MISS_MAX` are kept.
 */

export interface NewSearchMiss {
  /** The author's message (cut to `SEARCH_MISS_QUESTION_MAX` characters). */
  question: string
  /** The navigator's search terms (at most `NAVIGATION_TERMS_MAX`). */
  terms: readonly string[]
  nodeId: string
  para: number
  /** The cited words (cut to `SEARCH_MISS_QUOTE_MAX` characters). */
  quote: string
  /** The answer's prompt version. */
  promptVersion: string
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

const Terms = z.array(z.string())

function termsOf(raw: string): string[] {
  try {
    const parsed = Terms.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

const toView = (row: SearchMissRow): SearchMissView => ({
  id: row.id,
  created: row.created,
  question: row.question,
  terms: termsOf(row.terms),
  nodeId: row.nodeId,
  para: row.para,
  quote: row.quote,
  promptVersion: row.promptVersion
})

/** Logs one miss and prunes the oldest past `SEARCH_MISS_MAX`; answers its id. */
export function logSearchMiss(db: TreeDb, miss: NewSearchMiss, now: Date): string {
  const id = randomUUID()
  const terms = miss.terms
    .map((term) => term.trim())
    .filter((term) => term !== '')
    .slice(0, NAVIGATION_TERMS_MAX)
  db.transaction((tx) => {
    tx.insert(searchMiss)
      .values({
        id,
        created: now.toISOString(),
        question: cut(miss.question, SEARCH_MISS_QUESTION_MAX),
        terms: JSON.stringify(terms),
        nodeId: miss.nodeId,
        para: miss.para,
        quote: cut(miss.quote, SEARCH_MISS_QUOTE_MAX),
        promptVersion: miss.promptVersion
      })
      .run()
    tx.run(
      sql`DELETE FROM search_miss WHERE id IN (
            SELECT id FROM search_miss ORDER BY created DESC, rowid DESC
            LIMIT -1 OFFSET ${SEARCH_MISS_MAX})`
    )
  })
  return id
}

/** How many misses are kept, and the newest `limit` of them (at most `SEARCH_MISSES_LIST_MAX`). */
export function searchMisses(db: TreeDb, limit: number): SearchMisses {
  const max = Math.min(Math.max(0, Math.floor(limit)), SEARCH_MISSES_LIST_MAX)
  const total = db.select({ n: count() }).from(searchMiss).get()?.n ?? 0
  const recent =
    max === 0
      ? []
      : db
          .select()
          .from(searchMiss)
          .orderBy(desc(searchMiss.created), sql`rowid DESC`)
          .limit(max)
          .all()
          .map(toView)
  return { count: total, recent }
}
