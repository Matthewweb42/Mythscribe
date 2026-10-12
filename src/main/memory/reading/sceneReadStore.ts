import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { ReadEntry } from '@shared/memory/gate'
import { sceneRead, type SceneReadRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * What of a scene has been read, per draft (F-16.16; P2a-D2): the one writer of `scene_read`.
 * The read set is cumulative between full reads (`nextReadSet` decides it); each window read
 * counts one partial, a full read resets them.
 */

const Entries = z.array(z.tuple([z.string(), z.string()]))

export interface SceneReadState {
  entries: ReadEntry[]
  partials: number
  fullAt: string | null
  readingId: string | null
  updated: string
}

function parseEntries(raw: string): ReadEntry[] {
  try {
    const parsed = Entries.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function getSceneRead(db: TreeDb, nodeId: string, draftId: string): SceneReadState | null {
  const row = getSceneReadRow(db, nodeId, draftId)
  if (row === null) return null
  return {
    entries: parseEntries(row.sentences),
    partials: row.partials,
    fullAt: row.fullAt,
    readingId: row.readingId,
    updated: row.updated
  }
}

/** The raw row (Rename in book's undo keeps it). */
export function getSceneReadRow(db: TreeDb, nodeId: string, draftId: string): SceneReadRow | null {
  return (
    db
      .select()
      .from(sceneRead)
      .where(and(eq(sceneRead.nodeId, nodeId), eq(sceneRead.draftId, draftId)))
      .get() ?? null
  )
}

/**
 * Records a reading of a scene: the new read set, one more partial for a window read (none after
 * a full one, which also stamps `full_at`), and the reading that did it.
 */
export function writeSceneRead(
  db: TreeDb,
  input: {
    nodeId: string
    draftId: string
    entries: readonly ReadEntry[]
    full: boolean
    readingId: string | null
  },
  now: Date
): void {
  const previous = getSceneRead(db, input.nodeId, input.draftId)
  const at = now.toISOString()
  const row: SceneReadRow = {
    nodeId: input.nodeId,
    draftId: input.draftId,
    sentences: JSON.stringify(input.entries),
    partials: input.full ? 0 : (previous?.partials ?? 0) + 1,
    fullAt: input.full ? at : (previous?.fullAt ?? null),
    readingId: input.readingId,
    updated: at
  }
  writeSceneReadRow(db, row)
}

/** Writes a row as it is (a rename's rewrite, its undo). */
export function writeSceneReadRow(db: TreeDb, row: SceneReadRow): void {
  db.insert(sceneRead)
    .values(row)
    .onConflictDoUpdate({ target: [sceneRead.nodeId, sceneRead.draftId], set: row })
    .run()
}
