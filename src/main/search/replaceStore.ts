import {
  EMPTY_REPLACE_PREVIEW,
  REPLACE_MAX_DOCUMENTS,
  countInDoc,
  isReplaceable,
  replaceInDoc,
  samplesInDoc,
  type ReplaceCommitResult,
  type ReplaceOptions,
  type ReplacePreview,
  type ReplacePreviewItem,
  type ReplaceRequest,
  type ReplaceUndoResult
} from '@shared/replace'
import { searchableText } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { parseStoredTiptap, saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { nodeLocation, nodesInTreeOrder } from './searchStore'

/**
 * Project-wide find and replace (F-10.2), main side. Documents only (every `kind === 'document'`
 * row, the rows search calls documents): never notes, entities, or titles. The preview and the
 * commit run the same pure functions of `@shared/replace` over the content as stored at that
 * moment, and every write goes through `saveDocument`, so the word count and `modified` move
 * exactly as they do for an editor save.
 */

/** One document the last commit changed: what it held before and what the commit wrote. */
interface UndoEntry {
  id: string
  before: string
  after: string
}

/**
 * The last commit's way back, in memory for the session: there is no Ctrl+Z across documents.
 * Bounded by one commit (the next one replaces it); `clearReplaceUndo` on every project change.
 */
let undoEntries: UndoEntry[] | null = null

/** Forgets the last commit (the project closed or another one opened). */
export function clearReplaceUndo(): void {
  undoEntries = null
}

/** How many documents the pending undo would look at. For tests. */
export function replaceUndoSize(): number {
  return undoEntries?.length ?? 0
}

interface Scope {
  /** The documents in the scope, in tree order. */
  documents: NodeRow[]
  byId: Map<string, NodeRow>
}

/** The documents a request covers: all of them, or `scopeId` (when it is one) and its descendants. */
function scopeOf(db: TreeDb, scopeId: string | null): Scope {
  const rows = listNodes(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const documents = nodesInTreeOrder(rows).filter((row) => row.kind === 'document')
  if (scopeId === null) return { documents, byId }
  if (!byId.has(scopeId)) throw new AppError('NOT_FOUND', 'Scope not found', { id: scopeId })
  const inScope = (row: NodeRow): boolean => {
    for (let at: NodeRow | undefined = row; at !== undefined;) {
      if (at.id === scopeId) return true
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    }
    return false
  }
  return { documents: documents.filter(inScope), byId }
}

/**
 * A stored content column as a document, or null when there is nothing to replace in: never
 * written, or no longer a Tiptap document (a corrupt row is left alone, not rewritten).
 */
function storedDoc(id: string, raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    return parseStoredTiptap(raw, id, 'document content')
  } catch {
    return null
  }
}

const optionsOf = ({
  query,
  replacement,
  matchCase,
  wholeWord
}: ReplaceOptions): ReplaceOptions => ({
  query,
  replacement,
  matchCase,
  wholeWord
})

/**
 * What a commit of `request` would change (F-10.2): one item per document holding the query, in
 * tree order, with samples only for the items under the cap. Writes nothing.
 */
export function previewReplace(db: TreeDb, request: ReplaceRequest): ReplacePreview {
  if (!isReplaceable(request)) {
    // The scope is still checked, so a stale one is reported whatever is typed.
    scopeOf(db, request.scopeId)
    return EMPTY_REPLACE_PREVIEW
  }
  const options = optionsOf(request)
  const { documents, byId } = scopeOf(db, request.scopeId)
  const hits: (() => ReplacePreviewItem)[] = []
  for (const row of documents) {
    const doc = storedDoc(row.id, row.content)
    if (doc === null) continue
    const count = countInDoc(doc, options)
    if (count === 0) continue
    hits.push(() => ({
      id: row.id,
      title: searchableText(row.title),
      location: nodeLocation(byId, row),
      count,
      samples: samplesInDoc(doc, options)
    }))
  }
  return {
    items: hits.slice(0, REPLACE_MAX_DOCUMENTS).map((hit) => hit()),
    total: hits.length,
    truncated: hits.length > REPLACE_MAX_DOCUMENTS
  }
}

/**
 * Replaces in the documents `ids` names (F-10.2), all in one transaction. Each document is
 * recomputed from its content as stored now, so a preview that has gone stale can never write
 * stale text; an id outside the scope, a document without a match, and an unreadable one are
 * skipped. The previous contents of what changed become the one pending undo — a commit that
 * changes nothing leaves the earlier one in place.
 */
export function commitReplace(
  db: TreeDb,
  request: ReplaceRequest,
  ids: readonly string[]
): ReplaceCommitResult {
  if (!isReplaceable(request)) return { changed: [], total: 0 }
  const options = optionsOf(request)
  const wanted = new Set(ids)
  const { documents } = scopeOf(db, request.scopeId)
  const entries: UndoEntry[] = []
  const changed = db.transaction((tx) => {
    const written: ReplaceCommitResult['changed'] = []
    for (const row of documents) {
      if (!wanted.has(row.id) || row.content === null) continue
      const doc = storedDoc(row.id, row.content)
      if (doc === null) continue
      const replaced = replaceInDoc(doc, options)
      if (replaced.count === 0) continue
      const { wordCount } = saveDocument(tx, row.id, replaced.doc)
      const after = getNode(tx, row.id)?.content
      if (after === null || after === undefined) {
        throw new AppError('INTERNAL', 'A replaced document did not store', { id: row.id })
      }
      entries.push({ id: row.id, before: row.content, after })
      written.push({ id: row.id, count: replaced.count, wordCount })
    }
    return written
  })
  if (entries.length > 0) undoEntries = entries
  return { changed, total: changed.reduce((sum, each) => sum + each.count, 0) }
}

/**
 * Takes the last commit back (F-10.2), in one transaction: a document is restored only while
 * its stored content is still exactly what the commit wrote. One that was edited since (or
 * deleted) is skipped and named, so an undo never destroys newer work. The undo is spent either
 * way.
 */
export function undoReplace(db: TreeDb): ReplaceUndoResult {
  const entries = undoEntries
  if (entries === null) return { restored: [], skipped: [] }
  const undone = db.transaction((tx) => {
    const result: ReplaceUndoResult = { restored: [], skipped: [] }
    for (const entry of entries) {
      const row = getNode(tx, entry.id)
      const before = storedDoc(entry.id, entry.before)
      if (row?.kind !== 'document' || row.content !== entry.after || before === null) {
        result.skipped.push(entry.id)
        continue
      }
      const { wordCount } = saveDocument(tx, entry.id, before)
      result.restored.push({ id: entry.id, wordCount })
    }
    return result
  })
  // Spent only once the transaction held: a failed undo can be tried again.
  undoEntries = null
  return undone
}
