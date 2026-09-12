import { eq } from 'drizzle-orm'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getNode, type TreeDb } from '../tree/treeStore'

/** What `document:get` returns: the node id and its Tiptap JSON, or null when nothing was written yet. */
export interface DocumentContent {
  id: string
  content: TiptapNodeT | null
}

/** What `document:save` returns: the cached word count and the row's new `modified` stamp. */
export interface SaveResult {
  wordCount: number
  modified: string
}

/** The row behind `id` if it is a document; NOT_FOUND or VALIDATION otherwise. Shared by read and write. */
function requireDocument(db: TreeDb, id: string): NodeRow {
  const row = getNode(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'Document not found', { id })
  if (row.kind !== 'document') {
    throw new AppError('VALIDATION', 'Only documents have content', { id, kind: row.kind })
  }
  return row
}

/**
 * Reads a document's content (F-3.1). Only `kind === 'document'` rows carry content; folders and
 * sections are refused. Stored JSON is validated against `TiptapNode` so a corrupt row surfaces
 * as an error instead of a half-rendered editor. `saveDocument` is the write path (F-3.2).
 */
export function getDocumentContent(db: TreeDb, id: string): DocumentContent {
  const row = requireDocument(db, id)
  return { id, content: row.content === null ? null : parseContent(row.content, id) }
}

/**
 * Replaces a document's content (F-3.2): stores the Tiptap JSON, caches `countWords` on the row
 * so the tree never has to parse content for its rollups, and stamps `modified`. Same refusals
 * as `getDocumentContent`.
 */
export function saveDocument(db: TreeDb, id: string, content: TiptapNodeT): SaveResult {
  requireDocument(db, id)
  const wordCount = countWords(content)
  const modified = new Date().toISOString()
  db.update(node)
    .set({ content: JSON.stringify(content), wordCount, modified })
    .where(eq(node.id, id))
    .run()
  return { wordCount, modified }
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
