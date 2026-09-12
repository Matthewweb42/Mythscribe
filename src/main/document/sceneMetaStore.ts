import { eq } from 'drizzle-orm'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { node } from '../db/schema'
import { requireContentTarget } from '../tree/contentTarget'
import type { TreeDb } from '../tree/treeStore'

/** What `sceneMeta:get` returns: the node id and its metadata (empty until something is written). */
export interface NodeSceneMeta {
  id: string
  meta: SceneMeta
}

/** What `sceneMeta:set` returns: the row's new `modified` stamp. */
export interface SceneMetaSetResult {
  modified: string
}

/**
 * Reads a node's scene metadata (F-4.5). Documents and folders both qualify (scenes, chapters,
 * and parts carry it); section roots are refused. A never-written or unreadable column reads as
 * empty metadata (`parseStoredSceneMeta`). `setSceneMeta` is the write path.
 */
export function getSceneMeta(db: TreeDb, id: string): NodeSceneMeta {
  const row = requireContentTarget(db, id, 'metadata')
  return { id, meta: parseStoredSceneMeta(row.sceneMeta) }
}

/** Replaces a node's scene metadata (F-4.5) and stamps `modified`. Same refusals as `getSceneMeta`. */
export function setSceneMeta(db: TreeDb, id: string, meta: SceneMeta): SceneMetaSetResult {
  requireContentTarget(db, id, 'metadata')
  const modified = new Date().toISOString()
  db.update(node)
    .set({ sceneMeta: JSON.stringify(meta), modified })
    .where(eq(node.id, id))
    .run()
  return { modified }
}
