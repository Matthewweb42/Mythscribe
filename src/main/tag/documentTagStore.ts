import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { DocumentTag, Tag } from '@shared/ipc/contract'
import { documentTag, documentTagDismissal, tag } from '../db/schema'
import { AppError } from '../ipc/errors'
import { requireContentTarget } from '../tree/contentTarget'
import { getTag, getTagWithUsage, type TagDb } from './tagStore'

/**
 * The node ↔ tag links (F-4.4) behind the tag bar. Documents and folders both carry tags (the
 * bar mounts on scenes and, in the stacked view, on the chapter or part itself, F-4.5); only the
 * section roots are refused, through the same `requireContentTarget` rule as notes and scene
 * metadata. Every write returns the tag with its fresh usage count, so the renderer can update
 * the bank in place instead of re-listing.
 */

/** The row behind `nodeId` if it can carry tags; NOT_FOUND or VALIDATION otherwise. */
function requireTaggable(db: TagDb, nodeId: string): void {
  requireContentTarget(db, nodeId, 'tags')
}

/** The tag behind `tagId`; NOT_FOUND otherwise. */
function requireTag(db: TagDb, tagId: string): void {
  if (!getTag(db, tagId)) throw new AppError('NOT_FOUND', 'Tag not found', { id: tagId })
}

/** The tag with its usage count, which must exist since it was checked inside the same transaction. */
function tagAfterWrite(db: TagDb, tagId: string): Tag {
  const updated = getTagWithUsage(db, tagId)
  if (!updated) throw new AppError('NOT_FOUND', 'Tag not found', { id: tagId })
  return updated
}

/** The `document_tag` row linking the pair, or undefined when they are not linked. */
function findLink(
  db: TagDb,
  nodeId: string,
  tagId: string
): { id: string; source: DocumentTag['source'] } | undefined {
  return db
    .select({ id: documentTag.id, source: documentTag.source })
    .from(documentTag)
    .where(and(eq(documentTag.nodeId, nodeId), eq(documentTag.tagId, tagId)))
    .get()
}

/**
 * The tags linked to a node (F-4.4), ordered by name, each with its usage count and the
 * `source` of the link (F-4.13: `ai` for one the background tagging job applied).
 */
export function listDocumentTags(db: TagDb, nodeId: string): DocumentTag[] {
  requireTaggable(db, nodeId)
  const ids = db
    .select({ tagId: documentTag.tagId, source: documentTag.source })
    .from(documentTag)
    .innerJoin(tag, eq(tag.id, documentTag.tagId))
    .where(eq(documentTag.nodeId, nodeId))
    .orderBy(asc(tag.name), asc(tag.id))
    .all()
  return ids.flatMap(({ tagId, source }) => {
    const row = getTagWithUsage(db, tagId)
    return row ? [{ ...row, source }] : []
  })
}

/**
 * Links a tag to a node (F-4.4). Linking an already-linked pair is a no-op, except that a link
 * the background job made becomes the author's (F-4.13), and the link lifts an earlier removal
 * of the pair, so the job may keep it up again. The tag is checked before the insert so an
 * unknown id is NOT_FOUND, not a raw foreign-key failure. Returns the tag with its usage count
 * after the link.
 */
export function addDocumentTag(db: TagDb, nodeId: string, tagId: string): Tag {
  return db.transaction((tx) => {
    requireTaggable(tx, nodeId)
    requireTag(tx, tagId)
    const link = findLink(tx, nodeId, tagId)
    if (!link) {
      tx.insert(documentTag)
        .values({ id: randomUUID(), nodeId, tagId, created: new Date().toISOString() })
        .run()
    } else if (link.source === 'ai') {
      tx.update(documentTag).set({ source: 'author' }).where(eq(documentTag.id, link.id)).run()
    }
    tx.delete(documentTagDismissal)
      .where(and(eq(documentTagDismissal.nodeId, nodeId), eq(documentTagDismissal.tagId, tagId)))
      .run()
    return tagAfterWrite(tx, tagId)
  })
}

/**
 * Removes a node ↔ tag link (F-4.4). Removing a link that is already gone is a no-op. A link
 * that was there, the author's or the job's, is remembered as removed (F-4.13), so the
 * background job never applies that tag to that node again. Returns the tag with its usage
 * count after the removal.
 */
export function removeDocumentTag(db: TagDb, nodeId: string, tagId: string): Tag {
  return db.transaction((tx) => {
    requireTaggable(tx, nodeId)
    requireTag(tx, tagId)
    if (findLink(tx, nodeId, tagId)) {
      tx.delete(documentTag)
        .where(and(eq(documentTag.nodeId, nodeId), eq(documentTag.tagId, tagId)))
        .run()
      tx.insert(documentTagDismissal).values({ nodeId, tagId }).onConflictDoNothing().run()
    }
    return tagAfterWrite(tx, tagId)
  })
}

/**
 * Makes the job's links of a node exactly `tagIds` (F-4.13), in one transaction: a tag the
 * author took off this node is left out, a tag the author linked stays the author's, a job link
 * the answer no longer names goes, and the rest are linked as `ai`. The author's own links are
 * never touched. Answers the tags whose link was added or dropped, so the caller can tell the
 * windows; empty when the node already stood that way. An empty list clears the job's links.
 */
export function replaceAutoTags(db: TagDb, nodeId: string, tagIds: readonly string[]): string[] {
  return db.transaction((tx) => {
    const links = tx
      .select({ id: documentTag.id, tagId: documentTag.tagId, source: documentTag.source })
      .from(documentTag)
      .where(eq(documentTag.nodeId, nodeId))
      .all()
    const dismissed = new Set(
      tx
        .select({ tagId: documentTagDismissal.tagId })
        .from(documentTagDismissal)
        .where(eq(documentTagDismissal.nodeId, nodeId))
        .all()
        .map((row) => row.tagId)
    )
    const wanted = new Set(tagIds.filter((tagId) => !dismissed.has(tagId)))
    const moved: string[] = []
    for (const link of links) {
      if (link.source !== 'ai' || wanted.has(link.tagId)) continue
      tx.delete(documentTag).where(eq(documentTag.id, link.id)).run()
      moved.push(link.tagId)
    }
    const linked = new Set(links.map((link) => link.tagId))
    const created = new Date().toISOString()
    for (const tagId of wanted) {
      if (linked.has(tagId)) continue
      tx.insert(documentTag)
        .values({ id: randomUUID(), nodeId, tagId, source: 'ai', created })
        .run()
      moved.push(tagId)
    }
    return moved
  })
}

/**
 * Every node ↔ tag link in one query, as the tag names of each node (name order), keyed by node
 * id. The query ranker (F-5.7) scores every manuscript document in one pass and must not run a
 * query per scene; a node with no tag is simply absent from the map. Unlike `listDocumentTags`
 * this reads across the whole project, so it takes no target and checks nothing: it is a read
 * for ranking, not for the tag bar.
 */
export function listAllDocumentTags(db: TagDb): Map<string, string[]> {
  const rows = db
    .select({ nodeId: documentTag.nodeId, name: tag.name })
    .from(documentTag)
    .innerJoin(tag, eq(tag.id, documentTag.tagId))
    .orderBy(asc(documentTag.nodeId), asc(tag.name))
    .all()
  const byNode = new Map<string, string[]>()
  for (const row of rows) {
    const names = byNode.get(row.nodeId)
    if (names === undefined) byNode.set(row.nodeId, [row.name])
    else names.push(row.name)
  }
  return byNode
}

/**
 * Every node ↔ tag link in the project as id pairs (F-4.10), ordered by node id then tag name.
 * The tree filter and the Tag Manager's document list both need the whole map at once, and the
 * renderer already owns the tag records, so this returns ids only. Like `listAllDocumentTags`
 * it reads across the project and checks no target; the inner join drops a link whose tag is
 * gone.
 */
export function listAllDocumentTagLinks(db: TagDb): { nodeId: string; tagId: string }[] {
  return db
    .select({ nodeId: documentTag.nodeId, tagId: documentTag.tagId })
    .from(documentTag)
    .innerJoin(tag, eq(tag.id, documentTag.tagId))
    .orderBy(asc(documentTag.nodeId), asc(tag.name), asc(tag.id))
    .all()
}
