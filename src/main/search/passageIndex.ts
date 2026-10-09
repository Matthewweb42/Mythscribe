import { sql } from 'drizzle-orm'
import type { Paragraph } from '@shared/mentions'
import { sha256 } from '../ai/request'
import { deleteScans } from '../tag/mentionStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * The local full-text index of the manuscript (F-9.12): one `passage_fts` row per paragraph
 * with text of every manuscript document's live text (`passageParagraphs`), FTS5 with
 * `porter unicode61 remove_diacritics 2` (migration 0022, a virtual table drizzle does not model,
 * so it is read and written here with plain SQL). The mention scan (`scanMentions.ts`) is the one
 * writer, in the same transaction as the document's mentions, and skips the rewrite when the
 * paragraphs hash as they did (`mention_scan.passage_hash`). Notes and sheets are not indexed.
 * Nothing leaves the machine, and the document itself is only ever read.
 */

/** Bumped when what goes into the index changes, so every document is written again. */
export const PASSAGE_INDEX_VERSION = 1

/** Most results `searchPassages` answers, whatever the caller asks for. */
export const PASSAGE_SEARCH_MAX = 50

/** Most terms of a query that are looked for; the rest are ignored. */
const QUERY_TERMS_MAX = 16

/** Tokens of context `snippet()` keeps around the match. */
const SNIPPET_TOKENS = 16

export interface PassageHit {
  nodeId: string
  /** The paragraph's index in its document (`passageParagraphs`). */
  para: number
  /** The matching stretch of the paragraph, plain text, with `…` where it was cut. */
  snippet: string
  /** Higher is better (bm25, negated). */
  score: number
}

/** The hash a document's indexed paragraphs are compared by. */
export function passageHash(paragraphs: readonly Paragraph[]): string {
  return sha256(JSON.stringify({ v: PASSAGE_INDEX_VERSION, texts: paragraphs.map((p) => p.text) }))
}

/** Replaces one document's rows (the caller holds the transaction). */
export function replaceNodePassages(
  db: TreeDb,
  nodeId: string,
  paragraphs: readonly Paragraph[]
): void {
  db.run(sql`DELETE FROM passage_fts WHERE node_id = ${nodeId}`)
  for (const paragraph of paragraphs) {
    db.run(
      sql`INSERT INTO passage_fts (node_id, para, text) VALUES (${nodeId}, ${paragraph.index}, ${paragraph.text})`
    )
  }
}

/**
 * Drops the rows of every document that is no longer in the manuscript (deleted, or moved to
 * the notes), with their scan rows, so one that comes back is scanned and indexed afresh.
 * Answers how many documents went. Runs on project open; searches skip such rows anyway.
 */
export function prunePassages(db: TreeDb): number {
  const keep = new Set(manuscriptDocuments(db).map((row) => row.id))
  const indexed = db
    .all<{ node_id: string }>(sql`SELECT DISTINCT node_id FROM passage_fts`)
    .map((row) => row.node_id)
  const gone = indexed.filter((id) => !keep.has(id))
  if (gone.length === 0) return 0
  db.transaction((tx) => {
    for (const id of gone) tx.run(sql`DELETE FROM passage_fts WHERE node_id = ${id}`)
    deleteScans(tx, gone)
  })
  return gone.length
}

/**
 * The query as FTS5 syntax that cannot carry any of its own: the words (letters and digits) of
 * `query`, each double-quoted, joined by OR so a passage with more of them ranks higher. Null
 * when no word is left.
 */
export function ftsQuery(query: string): string | null {
  const words = (query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, QUERY_TERMS_MAX)
  if (words.length === 0) return null
  return words.map((word) => `"${word}"`).join(' OR ')
}

/**
 * The manuscript paragraphs that best match `query`, best first (bm25). Each word of the query
 * is quoted, so FTS operators (`NEAR(`, `*`, `"`, `AND`, column filters) in it are plain words.
 * Rows of a document no longer in the manuscript are skipped.
 */
export function searchPassages(db: TreeDb, query: string, limit = 8): PassageHit[] {
  const match = ftsQuery(query)
  const max = Math.min(Math.max(0, Math.floor(limit)), PASSAGE_SEARCH_MAX)
  if (match === null || max === 0) return []
  const keep = new Set(manuscriptDocuments(db).map((row) => row.id))
  const rows = db.all<{ node_id: string; para: number; snippet: string; rank: number }>(
    sql`SELECT node_id, para,
          snippet(passage_fts, 2, '', '', '…', ${SNIPPET_TOKENS}) AS snippet,
          bm25(passage_fts) AS rank
        FROM passage_fts WHERE passage_fts MATCH ${match}
        ORDER BY rank LIMIT ${max * 3}`
  )
  return rows
    .filter((row) => keep.has(row.node_id))
    .slice(0, max)
    .map((row) => ({
      nodeId: row.node_id,
      para: Number(row.para),
      snippet: row.snippet,
      score: -row.rank
    }))
}
