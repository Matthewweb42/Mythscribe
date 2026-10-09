import { eq, inArray } from 'drizzle-orm'
import { AiSceneCard } from '@shared/sceneCard'
import { promptVersionAtLeast, StoredSceneSummary } from '@shared/summary'
import { sceneSummary, type SceneSummaryRow } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * The `scene_summary` rows (F-5.6): one derived summary per manuscript document, written by
 * `src/main/ai/summarize.ts` after the background run and read by the metadata pane and the
 * story bible's neighbour lines. A summary is not a proposal — nothing enters the manuscript
 * — so there is no status and no settlement here, only the latest row per node and the hash
 * of what it was made from.
 *
 * The JSON columns are read back through `StoredSceneSummary`: a row that no longer parses
 * (hand-edited, written by a newer version, corrupt) reads as no summary at all, so the
 * scheduler simply writes a fresh one instead of the pane showing nonsense.
 */

/** The stored summary for a node, or null when it has none (or its row no longer parses). */
export function getSummary(db: TreeDb, nodeId: string): StoredSceneSummary | null {
  const row = db.select().from(sceneSummary).where(eq(sceneSummary.nodeId, nodeId)).get()
  return row === undefined ? null : toStored(row)
}

/** Writes (or replaces) a node's summary; the node must exist, or the foreign key refuses it. */
export function upsertSummary(db: TreeDb, row: StoredSceneSummary): void {
  db.insert(sceneSummary)
    .values(toRow(row))
    .onConflictDoUpdate({ target: sceneSummary.nodeId, set: toRow(row) })
    .run()
}

/** Drops a node's summary; a node without one is a silent no-op. */
export function deleteSummary(db: TreeDb, nodeId: string): void {
  db.delete(sceneSummary).where(eq(sceneSummary.nodeId, nodeId)).run()
}

/**
 * The summaries for several nodes in one query, keyed by node id: the story bible reads its
 * two neighbours through this rather than two round trips per request. Ids without a row (or
 * with an unparseable one) are simply absent from the map.
 */
export function summariesFor(db: TreeDb, nodeIds: string[]): Map<string, StoredSceneSummary> {
  const found = new Map<string, StoredSceneSummary>()
  if (nodeIds.length === 0) return found
  for (const row of db
    .select()
    .from(sceneSummary)
    .where(inArray(sceneSummary.nodeId, nodeIds))
    .all()) {
    const stored = toStored(row)
    if (stored !== null) found.set(stored.nodeId, stored)
  }
  return found
}

/** The first prompt version that writes a scene card (F-9.14). */
const CARD_VERSION = 'summary.v4'

function toRow(row: StoredSceneSummary): SceneSummaryRow {
  return {
    nodeId: row.nodeId,
    contentHash: row.contentHash,
    summary: row.summary,
    keyPoints: JSON.stringify(row.keyPoints),
    characters: JSON.stringify(row.characters),
    promptVersion: row.promptVersion,
    model: row.model,
    truncated: row.truncated,
    createdAt: row.createdAt,
    card: row.card ? JSON.stringify(row.card) : null
  }
}

/**
 * The stored row as both sides read it. F-9.14: the card is read only from a row whose prompt
 * writes one, so a row an older build rewrote (it leaves the column as it was) never shows the
 * card of the text before; a card that no longer parses reads as none, not as a broken row.
 */
function toStored(row: SceneSummaryRow): StoredSceneSummary | null {
  const parsed = StoredSceneSummary.safeParse({
    ...row,
    keyPoints: parseList(row.keyPoints),
    characters: parseList(row.characters),
    card: undefined
  })
  if (!parsed.success) return null
  if (row.card === null || !promptVersionAtLeast(row.promptVersion, CARD_VERSION)) {
    return parsed.data
  }
  const card = AiSceneCard.safeParse(parseList(row.card))
  return card.success ? { ...parsed.data, card: card.data } : parsed.data
}

function parseList(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
