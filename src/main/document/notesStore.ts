import { eq } from 'drizzle-orm'
import type { TiptapNodeT } from '@shared/tiptap'
import { node } from '../db/schema'
import { requireContentTarget } from '../tree/contentTarget'
import type { TreeDb } from '../tree/treeStore'
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
 * Reads a node's notes (F-3.7). Documents and folders both have notes; section roots are refused
 * (`requireContentTarget`). Stored JSON is validated against `TiptapNode` so a corrupt row
 * surfaces as an error instead of a half-rendered editor. `saveNotes` is the write path.
 */
export function getNotes(db: TreeDb, id: string): NodeNotes {
  const row = requireContentTarget(db, id, 'notes')
  return { id, notes: row.notes === null ? null : parseStoredTiptap(row.notes, id, 'notes') }
}

/** Replaces a node's notes (F-3.7) and stamps `modified`. Same refusals as `getNotes`. */
export function saveNotes(db: TreeDb, id: string, notes: TiptapNodeT): NotesSaveResult {
  requireContentTarget(db, id, 'notes')
  const modified = new Date().toISOString()
  db.update(node)
    .set({ notes: JSON.stringify(notes), modified })
    .where(eq(node.id, id))
    .run()
  return { modified }
}
