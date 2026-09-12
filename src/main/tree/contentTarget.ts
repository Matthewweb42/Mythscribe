import type { NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getNode, type TreeDb } from './treeStore'

/**
 * The row behind `id` if it can carry per-node content such as notes (F-3.7), tag links
 * (F-4.4), or scene metadata (F-4.5); NOT_FOUND or VALIDATION otherwise. Documents and folders
 * both qualify; only the section roots (`parentId === null`) do not. The decision is by parent,
 * not by `kind`, because section roots are folders too. `what` names the refused content in the
 * message ("Sections have no notes").
 */
export function requireContentTarget(db: TreeDb, id: string, what: string): NodeRow {
  const row = getNode(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'Node not found', { id })
  if (row.parentId === null) {
    throw new AppError('VALIDATION', `Sections have no ${what}`, { id, sectionType: row.sectionType })
  }
  return row
}
