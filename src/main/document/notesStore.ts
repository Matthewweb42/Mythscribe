import { eq } from 'drizzle-orm'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getNode, type TreeDb } from '../tree/treeStore'
import { parseStoredTiptap } from './documentStore'

/** What `notes:get` returns: the node id and its notes as Tiptap JSON, or null when nothing was written yet. */
export interface NodeNotes {
  id: string
  notes: TiptapNodeT | null
}

/** What `notes:save` returns: the row's new `modified` stamp. */
export interface NotesSaveResult {
  modified: string
}

/**
 * The row behind `id` if it can carry notes; NOT_FOUND or VALIDATION otherwise. Documents and
 * folders both have notes; only the section roots (`parentId === null`) do not. The decision is
 * by parent, not by `kind`, because section roots are folders too.
 */
function requireNotesTarget(db: TreeDb, id: string): NodeRow {
  const row = getNode(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'Node not found', { id })
  if (row.parentId === null) {
    throw new AppError('VALIDATION', 'Sections have no notes', { id, sectionType: row.sectionType })
  }
  return row
}

/**
 * Reads a node's notes (F-3.7). Stored JSON is validated against `TiptapNode` so a corrupt row
 * surfaces as an error instead of a half-rendered editor. `saveNotes` is the write path.
 */
export function getNotes(db: TreeDb, id: string): NodeNotes {
  const row = requireNotesTarget(db, id)
  return { id, notes: row.notes === null ? null : parseStoredTiptap(row.notes, id, 'notes') }
}

/** Replaces a node's notes (F-3.7) and stamps `modified`. Same refusals as `getNotes`. */
export function saveNotes(db: TreeDb, id: string, notes: TiptapNodeT): NotesSaveResult {
  requireNotesTarget(db, id)
  const modified = new Date().toISOString()
  db.update(node)
    .set({ notes: JSON.stringify(notes), modified })
    .where(eq(node.id, id))
    .run()
  return { modified }
}
