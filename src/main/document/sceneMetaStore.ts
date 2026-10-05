import type { z } from 'zod'
import { eq } from 'drizzle-orm'
import { parseStoredSceneMeta, SceneMeta } from '@shared/sceneMeta'
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

/**
 * Replaces a node's scene metadata (F-4.5) and stamps `modified`. Same refusals as
 * `getSceneMeta`. Takes the schema's input shape, so a caller may leave out the defaulted fields
 * (the brief, synopsis, status); they are stored filled in.
 */
export function setSceneMeta(
  db: TreeDb,
  id: string,
  input: z.input<typeof SceneMeta>
): SceneMetaSetResult {
  requireContentTarget(db, id, 'metadata')
  const meta = SceneMeta.parse(input)
  const modified = new Date().toISOString()
  db.update(node)
    .set({ sceneMeta: JSON.stringify(meta), modified })
    .where(eq(node.id, id))
    .run()
  return { modified }
}
