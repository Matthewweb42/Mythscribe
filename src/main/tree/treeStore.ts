import type { RunResult } from 'better-sqlite3'
import { asc } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { TreeNode } from '@shared/ipc/contract'
import type * as schema from '../db/schema'
import { node, type NodeInsert, type NodeRow } from '../db/schema'

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
