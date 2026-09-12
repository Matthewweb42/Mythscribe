import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { AppError } from '../ipc/errors'
import { getNode, type TreeDb } from '../tree/treeStore'

/** What `document:get` returns: the node id and its Tiptap JSON, or null when nothing was written yet. */
export interface DocumentContent {
  id: string
  content: TiptapNodeT | null
}

/**
 * Reads a document's content (F-3.1). Only `kind === 'document'` rows carry content; folders and
 * sections are refused. Stored JSON is validated against `TiptapNode` so a corrupt row surfaces
 * as an error instead of a half-rendered editor. F-3.2 adds the write path beside this.
 */
export function getDocumentContent(db: TreeDb, id: string): DocumentContent {
  const row = getNode(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'Document not found', { id })
  if (row.kind !== 'document') {
    throw new AppError('VALIDATION', 'Only documents have content', { id, kind: row.kind })
  }
  return { id, content: row.content === null ? null : parseContent(row.content, id) }
}

function parseContent(raw: string, id: string): TiptapNodeT {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new AppError('INTERNAL', 'Stored document content is not valid JSON', { id })
  }
  const parsed = TiptapNode.safeParse(json)
  if (!parsed.success) {
    throw new AppError('INTERNAL', 'Stored document content is not a Tiptap document', {
      id,
      issues: parsed.error.issues
    })
  }
  return parsed.data
}
