import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { Tag } from '@shared/ipc/contract'
import { documentTag, tag, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getNode } from '../tree/treeStore'
import { getTag, getTagWithUsage, type TagDb } from './tagStore'

/**
 * The document ↔ tag links (F-4.4) behind the tag bar. Every write returns the tag with its
 * fresh usage count, so the renderer can update the bank in place instead of re-listing.
 */

/** The row behind `nodeId` if it is a document; NOT_FOUND or VALIDATION otherwise. */
function requireDocumentNode(db: TagDb, nodeId: string): NodeRow {
  const row = getNode(db, nodeId)
  if (!row) throw new AppError('NOT_FOUND', 'Document not found', { id: nodeId })
  if (row.kind !== 'document') {
    throw new AppError('VALIDATION', 'Only documents carry tags', { id: nodeId, kind: row.kind })
  }
  return row
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
function findLink(db: TagDb, nodeId: string, tagId: string): { id: string } | undefined {
  return db
    .select({ id: documentTag.id })
    .from(documentTag)
    .where(and(eq(documentTag.nodeId, nodeId), eq(documentTag.tagId, tagId)))
    .get()
}

/** The tags linked to a document (F-4.4), ordered by name, each with its usage count. */
export function listDocumentTags(db: TagDb, nodeId: string): Tag[] {
  requireDocumentNode(db, nodeId)
  const ids = db
    .select({ tagId: documentTag.tagId })
    .from(documentTag)
    .innerJoin(tag, eq(tag.id, documentTag.tagId))
    .where(eq(documentTag.nodeId, nodeId))
    .orderBy(asc(tag.name), asc(tag.id))
    .all()
  return ids.flatMap(({ tagId }) => {
    const row = getTagWithUsage(db, tagId)
    return row ? [row] : []
  })
}

/**
 * Links a tag to a document (F-4.4). Linking an already-linked pair is a no-op. The tag is
 * checked before the insert so an unknown id is NOT_FOUND, not a raw foreign-key failure.
 * Returns the tag with its usage count after the link.
 */
export function addDocumentTag(db: TagDb, nodeId: string, tagId: string): Tag {
  return db.transaction((tx) => {
    requireDocumentNode(tx, nodeId)
    requireTag(tx, tagId)
    if (!findLink(tx, nodeId, tagId)) {
      tx.insert(documentTag)
        .values({ id: randomUUID(), nodeId, tagId, created: new Date().toISOString() })
        .run()
    }
    return tagAfterWrite(tx, tagId)
  })
}

/**
 * Removes a document ↔ tag link (F-4.4). Removing a link that is already gone is a no-op.
 * Returns the tag with its usage count after the removal.
 */
export function removeDocumentTag(db: TagDb, nodeId: string, tagId: string): Tag {
  return db.transaction((tx) => {
    requireDocumentNode(tx, nodeId)
    requireTag(tx, tagId)
    tx.delete(documentTag)
      .where(and(eq(documentTag.nodeId, nodeId), eq(documentTag.tagId, tagId)))
      .run()
    return tagAfterWrite(tx, tagId)
  })
}
