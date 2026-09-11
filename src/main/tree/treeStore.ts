import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, asc, count, eq, gt, gte, ne, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { NovelFormat, TreeCreateInput, TreeNode } from '@shared/ipc/contract'
import { canPlaceLevel, defaultNodeTitle, type HierarchyLevel, type NodeKind } from '@shared/labels'
import type * as schema from '../db/schema'
import { node, type NodeInsert, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type TreeDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

export function insertNodes(db: TreeDb, rows: NodeInsert[]): void {
  if (rows.length === 0) return
  db.insert(node).values(rows).run()
}

/** Every node, ordered by parent then position. NULL sorts first in SQLite, so roots lead. */
export function listNodes(db: TreeDb): NodeRow[] {
  return db.select().from(node).orderBy(asc(node.parentId), asc(node.position), asc(node.id)).all()
}

/** The renderer-facing projection: structure and metadata, no content. */
export function toTreeNode(row: NodeRow): TreeNode {
  return {
    id: row.id,
    parentId: row.parentId,
    sectionType: row.sectionType,
    kind: row.kind,
    hierarchyLevel: row.hierarchyLevel,
    title: row.title,
    position: row.position,
    wordCount: row.wordCount,
    matterType: row.matterType,
    preset: row.preset,
    created: row.created,
    modified: row.modified
  }
}

function getNode(db: TreeDb, id: string): NodeRow | undefined {
  return db.select().from(node).where(eq(node.id, id)).get()
}

/** The (kind, level) pairs the domain model allows: scenes are documents, parts and chapters folders. */
function assertKindMatchesLevel(kind: NodeKind, level: HierarchyLevel | null): void {
  const expected = level === null ? kind : level === 'scene' ? 'document' : 'folder'
  if (kind !== expected) {
    throw new AppError('VALIDATION', `A ${level} must be a ${expected}`, { kind, level })
  }
}

/** Where a level may live (`canPlaceLevel`): part under the manuscript root, chapter under a part, scene under a chapter. */
function assertPlacement(parent: NodeRow, level: HierarchyLevel | null): void {
  if (!canPlaceLevel(level, parent)) {
    throw new AppError('VALIDATION', `A ${level} cannot be created here`, {
      level,
      parentId: parent.id
    })
  }
}

/** `row` and every ancestor up to and including its section root. */
function ancestorChain(db: TreeDb, row: NodeRow): NodeRow[] {
  const chain = [row]
  for (let current = row; current.parentId !== null;) {
    const parent = getNode(db, current.parentId)
    if (!parent) break
    chain.push(parent)
    current = parent
  }
  return chain
}

/**
 * Creates a node under `parentId` (F-2.2). Placed after `afterId` when given, else appended as
 * the last child; later siblings shift so positions stay contiguous.
 */
export function createNode(db: TreeDb, format: NovelFormat, input: TreeCreateInput): NodeRow {
  return db.transaction((tx) => {
    const parent = getNode(tx, input.parentId)
    if (!parent) {
      throw new AppError('NOT_FOUND', 'Parent node not found', { id: input.parentId })
    }
    if (parent.kind !== 'folder') {
      throw new AppError('VALIDATION', 'Nodes can only be created inside a folder', {
        parentId: parent.id
      })
    }
    assertKindMatchesLevel(input.kind, input.hierarchyLevel)
    assertPlacement(parent, input.hierarchyLevel)

    let position: number
    if (input.afterId !== undefined) {
      const after = getNode(tx, input.afterId)
      if (after?.parentId !== parent.id) {
        throw new AppError('NOT_FOUND', 'Sibling to insert after not found', {
          afterId: input.afterId
        })
      }
      position = after.position + 1
    } else {
      const total = tx.select({ n: count() }).from(node).where(eq(node.parentId, parent.id)).get()
      position = total?.n ?? 0
    }

    tx.update(node)
      .set({ position: sql`${node.position} + 1` })
      .where(and(eq(node.parentId, parent.id), gte(node.position, position)))
      .run()

    const now = new Date().toISOString()
    const title = input.title?.trim() ?? ''
    const row: NodeInsert = {
      id: randomUUID(),
      parentId: parent.id,
      sectionType: null,
      kind: input.kind,
      hierarchyLevel: input.hierarchyLevel,
      title: title.length > 0 ? title : defaultNodeTitle(format, input.kind, input.hierarchyLevel),
      position,
      wordCount: 0,
      created: now,
      modified: now
    }
    return tx.insert(node).values(row).returning().get()
  })
}

/** Renames a node (F-2.2). The three section roots keep their fixed labels. */
export function renameNode(db: TreeDb, id: string, title: string): NodeRow {
  const existing = getNode(db, id)
  if (!existing) throw new AppError('NOT_FOUND', 'Node not found', { id })
  if (existing.sectionType !== null) {
    throw new AppError('VALIDATION', 'Sections cannot be renamed', { id })
  }
  return db
    .update(node)
    .set({ title: title.trim(), modified: new Date().toISOString() })
    .where(eq(node.id, id))
    .returning()
    .get()
}

/**
 * Copies a node and everything inside it (F-2.3). The copy lands right after the original among
 * its siblings (later siblings shift by one), is titled "<title> (Copy)", and carries the
 * original's content, notes, scene metadata, matter type, preset, and word count. Descendants
 * keep their titles and get contiguous positions. Returns the new rows, the copy's root first.
 */
export function duplicateNode(db: TreeDb, id: string): NodeRow[] {
  return db.transaction((tx) => {
    const source = getNode(tx, id)
    if (!source) throw new AppError('NOT_FOUND', 'Node not found', { id })
    if (source.sectionType !== null || source.parentId === null) {
      throw new AppError('VALIDATION', 'Sections cannot be duplicated', { id })
    }

    tx.update(node)
      .set({ position: sql`${node.position} + 1` })
      .where(and(eq(node.parentId, source.parentId), gt(node.position, source.position)))
      .run()

    const now = new Date().toISOString()
    const rows: NodeRow[] = []
    const copy = (row: NodeRow, parentId: string, position: number, title: string): void => {
      const copied: NodeRow = {
        ...row,
        id: randomUUID(),
        parentId,
        sectionType: null,
        title,
        position,
        created: now,
        modified: now
      }
      rows.push(copied)
      const children = tx
        .select()
        .from(node)
        .where(eq(node.parentId, row.id))
        .orderBy(asc(node.position), asc(node.id))
        .all()
      children.forEach((child, index) => copy(child, copied.id, index, child.title))
    }
    copy(source, source.parentId, source.position + 1, `${source.title} (Copy)`)
    insertNodes(tx, rows)
    return rows
  })
}

/**
 * Deletes a node and everything inside it (F-2.3). Descendants go through the schema's
 * `ON DELETE CASCADE` (`foreign_keys` is on for every connection); later siblings shift up so
 * positions stay contiguous. The three section roots cannot be deleted.
 */
export function deleteNode(db: TreeDb, id: string): void {
  db.transaction((tx) => {
    const existing = getNode(tx, id)
    if (!existing) throw new AppError('NOT_FOUND', 'Node not found', { id })
    if (existing.sectionType !== null || existing.parentId === null) {
      throw new AppError('VALIDATION', 'Sections cannot be deleted', { id })
    }
    tx.delete(node).where(eq(node.id, id)).run()
    tx.update(node)
      .set({ position: sql`${node.position} - 1` })
      .where(and(eq(node.parentId, existing.parentId), gt(node.position, existing.position)))
      .run()
  })
}

/**
 * Moves a node with its subtree under `parentId` (F-2.4), within the same section only. `afterId`
 * is tri-state: omitted → last child; null → first child; an id → right after that sibling.
 * The old siblings close the gap first, then the new siblings make room (so a same-parent
 * reorder resolves against the gap-closed positions), and finally the moved row is updated.
 * Returns the moved row.
 */
export function moveNode(
  db: TreeDb,
  id: string,
  parentId: string,
  afterId: string | null | undefined
): NodeRow {
  return db.transaction((tx) => {
    const moving = getNode(tx, id)
    if (!moving) throw new AppError('NOT_FOUND', 'Node not found', { id })
    if (moving.sectionType !== null || moving.parentId === null) {
      throw new AppError('VALIDATION', 'Sections cannot be moved', { id })
    }
    const parent = getNode(tx, parentId)
    if (!parent) throw new AppError('NOT_FOUND', 'Parent node not found', { id: parentId })
    if (parent.kind !== 'folder') {
      throw new AppError('VALIDATION', 'Nodes can only be moved into a folder', { parentId })
    }
    const parentChain = ancestorChain(tx, parent)
    const movingChain = ancestorChain(tx, moving)
    if (parentChain.at(-1)?.id !== movingChain.at(-1)?.id) {
      throw new AppError('VALIDATION', 'Moves are restricted to within a section', {
        id,
        parentId
      })
    }
    if (parentChain.some((ancestor) => ancestor.id === moving.id)) {
      throw new AppError('VALIDATION', 'Cannot move a node into itself or its own descendant', {
        id,
        parentId
      })
    }
    if (!canPlaceLevel(moving.hierarchyLevel, parent)) {
      throw new AppError('VALIDATION', `A ${moving.hierarchyLevel} cannot be moved here`, {
        level: moving.hierarchyLevel,
        parentId
      })
    }
    if (afterId === id) {
      throw new AppError('VALIDATION', 'Cannot move a node after itself', { id })
    }

    // 1. Close the gap the node leaves among its old siblings.
    tx.update(node)
      .set({ position: sql`${node.position} - 1` })
      .where(and(eq(node.parentId, moving.parentId), gt(node.position, moving.position)))
      .run()

    // 2. Resolve the target position against the gap-closed new siblings (excluding the node).
    let position: number
    if (afterId === undefined) {
      const total = tx
        .select({ n: count() })
        .from(node)
        .where(and(eq(node.parentId, parent.id), ne(node.id, id)))
        .get()
      position = total?.n ?? 0
    } else if (afterId === null) {
      position = 0
    } else {
      const after = getNode(tx, afterId)
      if (after?.parentId !== parent.id) {
        throw new AppError('NOT_FOUND', 'Sibling to move after not found', { afterId })
      }
      position = after.position + 1
    }

    // 3. Make room among the new siblings.
    tx.update(node)
      .set({ position: sql`${node.position} + 1` })
      .where(and(eq(node.parentId, parent.id), gte(node.position, position), ne(node.id, id)))
      .run()

    // 4. Land the node; unconditional so a same-parent reorder overwrites its stale position.
    return tx
      .update(node)
      .set({ parentId: parent.id, position, modified: new Date().toISOString() })
      .where(eq(node.id, id))
      .returning()
      .get()
  })
}
