import { eq, inArray } from 'drizzle-orm'
import { MentionRange, TagMentions } from '@shared/mentions'
import { mentionScan, tagMention, type TagMentionRow } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * The `tag_mention` and `mention_scan` rows (F-4.12): where each tracked tag's name occurs in
 * each manuscript document, and the hash of what the last scan of that document saw.
 * `src/main/tag/scanMentions.ts` is the only writer; the two `mention:*` channels read.
 *
 * A row that no longer parses (a hand-edited `positions` cell, one written by a newer build)
 * never throws here: its ranges read as none, and a row that is not a mention at all (a count
 * of zero) is skipped, so the tag bar shows one fewer document rather than a crash.
 */

/** `<tagId>:<nodeId>`: one row per pair, so a rescan replaces its rows instead of piling up. */
export function mentionId(tagId: string, nodeId: string): string {
  return `${tagId}:${nodeId}`
}

/** Every document that mentions the tag (F-4.12). Ordering is the caller's: the tree knows reading order. */
export function listMentionsForTag(db: TreeDb, tagId: string): TagMentions[] {
  return rows(db.select().from(tagMention).where(eq(tagMention.tagId, tagId)).all())
}

/** Every tag mentioned in the document, whether or not it is also linked to it (F-4.4). */
export function listMentionsForNode(db: TreeDb, nodeId: string): TagMentions[] {
  return rows(db.select().from(tagMention).where(eq(tagMention.nodeId, nodeId)).all())
}

/**
 * What one scan leaves behind, in one transaction: the document's old rows go, the tags that
 * were found get a row each, and the scan's hash is recorded. A tag with no occurrence has no
 * row, so "mentioned in N documents" never counts a zero.
 */
export function replaceNodeMentions(
  db: TreeDb,
  nodeId: string,
  mentions: Map<string, MentionRange[]>,
  contentHash: string,
  now: Date
): void {
  const at = now.toISOString()
  db.transaction((tx) => {
    tx.delete(tagMention).where(eq(tagMention.nodeId, nodeId)).run()
    for (const [tagId, ranges] of mentions) {
      if (ranges.length === 0) continue
      tx.insert(tagMention)
        .values({
          id: mentionId(tagId, nodeId),
          tagId,
          nodeId,
          count: ranges.length,
          positions: JSON.stringify(ranges),
          updatedAt: at
        })
        .run()
    }
    const scan = { nodeId, contentHash, scannedAt: at }
    tx.insert(mentionScan)
      .values(scan)
      .onConflictDoUpdate({ target: mentionScan.nodeId, set: scan })
      .run()
  })
}

/** The hash the last scan of this document was made from, or null when it has never been scanned. */
export function getScanHash(db: TreeDb, nodeId: string): string | null {
  const row = db.select().from(mentionScan).where(eq(mentionScan.nodeId, nodeId)).get()
  return row === undefined ? null : row.contentHash
}

/** The same for several documents in one query: what the backfill compares against on project open. */
export function scanHashes(db: TreeDb, nodeIds: string[]): Map<string, string> {
  const found = new Map<string, string>()
  if (nodeIds.length === 0) return found
  for (const row of db
    .select()
    .from(mentionScan)
    .where(inArray(mentionScan.nodeId, nodeIds))
    .all()) {
    found.set(row.nodeId, row.contentHash)
  }
  return found
}

/**
 * Forgets everything recorded for one tag (the author turned its tracking off) and answers the
 * documents that lose a row, for the `mention:changed` event. Their scan rows go with them: the
 * hash would otherwise match again the moment tracking comes back on and the rows would never
 * be rebuilt.
 */
export function deleteMentionsForTag(db: TreeDb, tagId: string): string[] {
  return db.transaction((tx) => {
    const nodeIds = tx
      .select({ nodeId: tagMention.nodeId })
      .from(tagMention)
      .where(eq(tagMention.tagId, tagId))
      .all()
      .map((row) => row.nodeId)
    if (nodeIds.length === 0) return []
    tx.delete(tagMention).where(eq(tagMention.tagId, tagId)).run()
    deleteScans(tx, nodeIds)
    return nodeIds
  })
}

/** Forgets what the last scan of these documents saw, so the next one runs whatever the hash says. */
export function deleteScans(db: TreeDb, nodeIds: string[]): void {
  if (nodeIds.length === 0) return
  db.delete(mentionScan).where(inArray(mentionScan.nodeId, nodeIds)).run()
}

/** The stored rows as the channels answer them; one that no longer parses is left out. */
function rows(found: TagMentionRow[]): TagMentions[] {
  const mentions: TagMentions[] = []
  for (const row of found) {
    const parsed = TagMentions.safeParse({
      tagId: row.tagId,
      nodeId: row.nodeId,
      count: row.count,
      ranges: parseRanges(row.positions)
    })
    if (parsed.success) mentions.push(parsed.data)
  }
  return mentions
}

function parseRanges(raw: string): MentionRange[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = MentionRange.array().safeParse(json)
  return parsed.success ? parsed.data : []
}
