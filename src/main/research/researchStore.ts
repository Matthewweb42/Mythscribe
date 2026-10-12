import { asc, eq } from 'drizzle-orm'
import { contextFileTypeOf, type ContextFileType } from '@shared/contextLibrary'
import type { NovelFormat } from '@shared/ipc/contract'
import {
  RESEARCH_TITLE_MAX,
  alreadyInResearch,
  writtenResearchDoc,
  type ResearchAddResult,
  type ResearchDoc
} from '@shared/research'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { contextFile, researchDoc, type NodeRow, type ResearchDocRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { readDocx } from '../import/docx'
import type { ImportBlock } from '../import/blocks'
import { readMarkdown, readPlainText } from '../import/text'
import { AppError } from '../ipc/errors'
import {
  addContextFileOutcomes,
  requireContextFileRow,
  storedPath,
  type ContextSource
} from '../library/libraryStore'
import { createNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import {
  isResearchRoot,
  isUnderResearch,
  researchDocumentIds,
  researchRootId,
  subtreeInOrder
} from './researchTree'

/**
 * The Research section (F-16.8, story memory v2; plan P1 §2.2): the one writer of
 * `research_doc`. A Research document is an ordinary document node under the Research root
 * (`ensureResearchRoot`), edited like any other and saved through `document:save`; its row says
 * where it came from, the original it was made from (kept in the library folder through
 * `addContextFileOutcomes`, under the `separate` same-name rule so an original is never swapped
 * under a document), and whether the whole page is Not canon. Uploads become editable pages:
 * Word through `readDocx`, Markdown through `readMarkdown`, text through `readPlainText`, a PDF's
 * text layer read out (`converted`), and an image a page with one empty caption paragraph whose
 * file opens with Open original. Nothing here is AI and nothing leaves the machine.
 */

/** The Research document behind `nodeId`: NOT_FOUND when it is gone, VALIDATION when it is something else. */
export function requireResearchDocument(db: TreeDb, nodeId: string): NodeRow {
  const row = getNode(db, nodeId)
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That document no longer exists', { nodeId })
  if (row.kind !== 'document' || !isUnderResearch(db, row)) {
    throw new AppError('VALIDATION', 'Not a Research document', { nodeId })
  }
  return row
}

/** Where new Research goes: the Research root or a folder under it; the root when none is given. */
function requireResearchFolder(db: TreeDb, parentId: string | undefined): NodeRow {
  const id = parentId ?? researchRootId(db)
  if (id === null) throw new AppError('VALIDATION', 'This project has no Research section')
  const row = getNode(db, id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'That folder no longer exists', { id })
  if (row.kind !== 'folder' || (!isResearchRoot(row) && !isUnderResearch(db, row))) {
    throw new AppError('VALIDATION', 'Not a Research folder', { id })
  }
  return row
}

function toResearchDoc(
  nodeId: string,
  row: ResearchDocRow | undefined,
  fileName: string | null
): ResearchDoc {
  if (row === undefined) return writtenResearchDoc(nodeId)
  return {
    nodeId,
    origin: row.origin,
    contextFileId: row.contextFileId,
    fileName,
    fileType: row.fileType,
    converted: row.converted,
    notCanon: row.notCanon,
    filedAt: row.filedAt
  }
}

function metaRow(
  db: TreeDb,
  nodeId: string
): { row: ResearchDocRow; fileName: string | null } | undefined {
  const found = db
    .select({ row: researchDoc, fileName: contextFile.name })
    .from(researchDoc)
    .leftJoin(contextFile, eq(contextFile.id, researchDoc.contextFileId))
    .where(eq(researchDoc.nodeId, nodeId))
    .get()
  return found === undefined ? undefined : { row: found.row, fileName: found.fileName }
}

/** One Research document's meta (a document with no row reads as written and canon). */
export function researchDocOf(db: TreeDb, nodeId: string): ResearchDoc {
  requireResearchDocument(db, nodeId)
  const found = metaRow(db, nodeId)
  return toResearchDoc(nodeId, found?.row, found?.fileName ?? null)
}

/** Every Research document's meta, in tree order. */
export function listResearchDocs(db: TreeDb): ResearchDoc[] {
  const ids = researchDocumentIds(listNodes(db))
  const rows = new Map(
    db
      .select({ row: researchDoc, fileName: contextFile.name })
      .from(researchDoc)
      .leftJoin(contextFile, eq(contextFile.id, researchDoc.contextFileId))
      .all()
      .map((each) => [each.row.nodeId, each])
  )
  return ids.map((id) => {
    const found = rows.get(id)
    return toResearchDoc(id, found?.row, found?.fileName ?? null)
  })
}

/**
 * A written Research note (`research:create`): an empty document under `parentId` (default the
 * root), right after `afterId` when given, else last.
 */
export function createResearchNote(
  db: TreeDb,
  format: NovelFormat,
  input: { parentId?: string; afterId?: string; title?: string },
  now: Date = new Date()
): NodeRow {
  return db.transaction((tx) => {
    const parent = requireResearchFolder(tx, input.parentId)
    const created = createNode(tx, format, {
      parentId: parent.id,
      kind: 'document',
      hierarchyLevel: null,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.title === undefined ? {} : { title: input.title.slice(0, RESEARCH_TITLE_MAX) })
    })
    tx.insert(researchDoc)
      .values({ nodeId: created.id, origin: 'written', created: now.toISOString() })
      .run()
    return created
  })
}

/** Switches a whole Research page Not canon, or back (`research:setNotCanon`). */
export function setResearchNotCanon(
  db: TreeDb,
  nodeId: string,
  notCanon: boolean,
  now: Date = new Date()
): ResearchDoc {
  return db.transaction((tx) => {
    requireResearchDocument(tx, nodeId)
    tx.insert(researchDoc)
      .values({ nodeId, origin: 'written', notCanon, created: now.toISOString() })
      .onConflictDoUpdate({ target: researchDoc.nodeId, set: { notCanon } })
      .run()
    return researchDocOf(tx, nodeId)
  })
}

/** A page's filing state (F-16.9): when it was filed and the hash of its text then; nulls until it is. */
export function researchFiled(
  db: TreeDb,
  nodeId: string
): { filedAt: string | null; filedHash: string | null } {
  const row = db
    .select({ filedAt: researchDoc.filedAt, filedHash: researchDoc.filedHash })
    .from(researchDoc)
    .where(eq(researchDoc.nodeId, nodeId))
    .get()
  return { filedAt: row?.filedAt ?? null, filedHash: row?.filedHash ?? null }
}

/**
 * Records that a page was filed into Pinned (F-16.9), or clears it (*Undo filing*: both null). A
 * written note with no row gets one, as the Not canon switch does.
 */
export function setResearchFiled(
  db: TreeDb,
  nodeId: string,
  filed: { filedAt: string | null; filedHash: string | null },
  now: Date = new Date()
): void {
  requireResearchDocument(db, nodeId)
  db.insert(researchDoc)
    .values({ nodeId, origin: 'written', created: now.toISOString(), ...filed })
    .onConflictDoUpdate({ target: researchDoc.nodeId, set: filed })
    .run()
}

/** The file name without its extension, as a document title. */
function titleOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const bare = dot > 0 ? name.slice(0, dot) : name
  return (bare.trim() === '' ? name : bare.trim()).slice(0, RESEARCH_TITLE_MAX)
}

/** Heading levels the page schema has (1–3); a deeper heading is shown as a level 3. */
const PAGE_HEADING_MAX = 3

/**
 * Import blocks as a page: paragraphs as read (marks and the imported origin kept), headings at
 * levels 1–3, a glyph line as a scene break, blank lines dropped (a Research page has no scenes
 * to split). An empty result is one empty paragraph, so the page can be typed into.
 */
export function blocksToPage(blocks: readonly ImportBlock[]): TiptapNodeT {
  const content: TiptapNodeT[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') content.push(block.node)
    else if (block.type === 'heading') {
      content.push({
        type: 'heading',
        attrs: { level: Math.min(Math.max(block.level, 1), PAGE_HEADING_MAX) },
        content: [{ type: 'text', text: block.text }]
      })
    } else if (block.type === 'break') content.push({ type: 'sceneBreak' })
  }
  return content.length === 0 ? EMPTY_DOC : { type: 'doc', content }
}

/** What an upload becomes: the page, and whether its text was read out of a PDF. */
export interface ResearchPage {
  doc: TiptapNodeT
  converted: boolean
}

/**
 * An uploaded file as an editable page. Word keeps its headings, paragraphs and emphasis
 * (`readDocx`); Markdown its headings and emphasis; text its paragraphs; a PDF's text layer
 * (`text`, already extracted) is read as text and marked converted (no OCR: a scanned PDF gives
 * an empty page); an image is one empty caption paragraph.
 */
export async function researchPage(
  type: ContextFileType,
  data: Buffer,
  text: string | null
): Promise<ResearchPage> {
  switch (type) {
    case 'docx':
      return { doc: blocksToPage(await readDocx(data)), converted: false }
    case 'md':
      return { doc: blocksToPage(readMarkdown(data.toString('utf8'))), converted: false }
    case 'txt':
      return { doc: blocksToPage(readPlainText(data.toString('utf8'))), converted: false }
    case 'pdf':
      return { doc: blocksToPage(readPlainText(text ?? '')), converted: true }
    case 'image':
      return { doc: EMPTY_DOC, converted: false }
  }
}

/** The document already made from library file `contextFileId`, if one is still in Research. */
function documentOfFile(db: TreeDb, contextFileId: string): NodeRow | undefined {
  const rows = db
    .select({ nodeId: researchDoc.nodeId })
    .from(researchDoc)
    .where(eq(researchDoc.contextFileId, contextFileId))
    .orderBy(asc(researchDoc.created))
    .all()
  for (const { nodeId } of rows) {
    const row = getNode(db, nodeId)
    if (row !== undefined && isUnderResearch(db, row)) return row
  }
  return undefined
}

/** Why Research refuses a file of another type (the Library's message names the Library). */
export const RESEARCH_TYPES_MESSAGE = 'Research takes Word, Markdown, text, PDF, and image files.'

/**
 * Adds uploaded files to Research (`research:add`): each original goes into the library folder
 * (`addContextFileOutcomes`, the `separate` rule: only the same bytes under the same name are
 * the same file), then becomes a document under `parentId` (default the root), in the order
 * given. A file already in Research is skipped with the document's title; a file the library
 * already held without a document gets one, and from then on the row is Research's
 * (`researchOriginalIds`: the Library no longer lists or updates it). A refused file is skipped
 * with the reason.
 */
export async function addResearchFiles(
  db: TreeDb,
  folder: string,
  format: NovelFormat,
  sources: readonly ContextSource[],
  parentId?: string,
  now: Date = new Date()
): Promise<ResearchAddResult> {
  const parent = requireResearchFolder(db, parentId)
  const created: string[] = []
  const skipped: ResearchAddResult['skipped'] = []
  const taken = sources.filter((source) => {
    if (contextFileTypeOf(source.name) !== null) return true
    skipped.push({ name: source.name, reason: RESEARCH_TYPES_MESSAGE })
    return false
  })
  const outcomes = await addContextFileOutcomes(db, folder, taken, { sameName: 'separate' })
  for (const outcome of outcomes) {
    if (outcome.outcome === 'skipped' || outcome.id === null || outcome.type === null) {
      skipped.push({ name: outcome.name, reason: outcome.reason ?? 'The file could not be added.' })
      continue
    }
    const existing = documentOfFile(db, outcome.id)
    if (existing !== undefined) {
      skipped.push({ name: outcome.name, reason: alreadyInResearch(existing.title) })
      continue
    }
    const data = outcome.data ?? Buffer.alloc(0)
    const page = await researchPage(outcome.type, data, outcome.text)
    const fileId = outcome.id
    const fileType = outcome.type
    const made = db.transaction((tx) => {
      const row = createNode(tx, format, {
        parentId: parent.id,
        kind: 'document',
        hierarchyLevel: null,
        title: titleOf(outcome.name)
      })
      saveDocument(tx, row.id, page.doc)
      tx.insert(researchDoc)
        .values({
          nodeId: row.id,
          origin: 'upload',
          contextFileId: fileId,
          fileType,
          converted: page.converted,
          created: now.toISOString()
        })
        .run()
      return row
    })
    created.push(made.id)
  }
  return { created, skipped }
}

/**
 * The stored original of an uploaded Research document (`research:openOriginal`), through the
 * library's path check (`storedPath` refuses a hand-edited name that leaves the library folder).
 * VALIDATION for a written document, NOT_FOUND when the original's row is gone.
 */
export function researchOriginalPath(db: TreeDb, folder: string, nodeId: string): string {
  const doc = researchDocOf(db, nodeId)
  if (doc.origin !== 'upload' || doc.contextFileId === null) {
    throw new AppError('VALIDATION', 'This document has no original file', { nodeId })
  }
  return storedPath(folder, requireContextFileRow(db, doc.contextFileId).stored)
}

/**
 * Carries the Research meta of a duplicated subtree onto its copy (`tree:duplicate`): `copies`
 * is `duplicateNode`'s answer, the copy's root first and the rest in the same preorder (by
 * position) as the source's subtree, so the two lists pair up one for one. A copy of an upload
 * keeps its original and its Not canon switch.
 */
export function copyResearchMeta(
  db: TreeDb,
  sourceId: string,
  copies: readonly NodeRow[],
  now: Date = new Date()
): void {
  const source = getNode(db, sourceId)
  if (source === undefined || !isUnderResearch(db, source)) return
  const order = subtreeInOrder(listNodes(db), sourceId)
  db.transaction((tx) => {
    order.forEach((original, at) => {
      const copy = copies[at]
      if (copy === undefined || original.kind !== 'document') return
      const meta = metaRow(tx, original.id)?.row
      if (meta === undefined) return
      tx.insert(researchDoc)
        .values({ ...meta, nodeId: copy.id, created: now.toISOString() })
        .onConflictDoNothing()
        .run()
    })
  })
}
