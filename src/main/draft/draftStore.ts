import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import {
  DraftName,
  FIRST_DRAFT_NAME,
  type DraftChange,
  type DraftComparison,
  type DraftDocDiff,
  type DraftList
} from '@shared/drafts'
import { diffWordCount, diffWords } from '@shared/textDiff'
import { draft, draftText, node, settings, type DraftRow, type NodeRow } from '../db/schema'
import { parseStoredTiptap, requireDocument, saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * Drafts (F-8.5): named versions of the manuscript's text. The active draft's text is the live
 * `node.content` (so every other read path is untouched); an inactive draft keeps a `draft_text`
 * row per manuscript document. The one rule every operation uses: a draft reads a document as
 * its row, or as the live text when it has none (`textOf`). Only manuscript documents take part;
 * titles, notes, metadata, and tags are shared by every draft.
 *
 * Every operation runs in one transaction. Switching and reverting rewrite live text through
 * `saveDocument`, so word counts and `modified` move as for a save; the caller follows up with
 * `documentsWritten` and never `recordWriting` (a switch is not words written).
 */

/** The settings key holding the active draft's id (a JSON string). */
export const ACTIVE_DRAFT_KEY = 'activeDraft'

/** One document's text as a draft reads it: the stored Tiptap JSON (null = empty) and its words. */
interface DraftText {
  content: string | null
  wordCount: number
}

/** The drafts and the active id, after `ensureDrafts` made sure there is at least one. */
interface DraftState {
  drafts: DraftRow[]
  activeId: string
}

function readActiveId(db: TreeDb): string | null {
  const row = db.select().from(settings).where(eq(settings.key, ACTIVE_DRAFT_KEY)).get()
  if (!row) return null
  try {
    const value: unknown = JSON.parse(row.value)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function writeActiveId(db: TreeDb, id: string): void {
  const value = JSON.stringify(id)
  db.insert(settings)
    .values({ key: ACTIVE_DRAFT_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

function listDraftRows(db: TreeDb): DraftRow[] {
  return db.select().from(draft).orderBy(asc(draft.position), asc(draft.created)).all()
}

/**
 * The drafts of the project, creating the first one ("Draft 1", active) when there is none. An
 * active id that is missing or names no draft (a hand-edited file) is repaired to the first draft:
 * the live text is kept as that draft's, and any rows it had are dropped (the active draft has
 * none by the model).
 */
export function ensureDrafts(db: TreeDb): DraftState {
  let drafts = listDraftRows(db)
  if (drafts.length === 0) {
    const now = new Date().toISOString()
    db.insert(draft)
      .values({
        id: randomUUID(),
        name: FIRST_DRAFT_NAME,
        position: 0,
        created: now,
        modified: now
      })
      .run()
    drafts = listDraftRows(db)
  }
  const stored = readActiveId(db)
  if (stored !== null && drafts.some((each) => each.id === stored)) {
    return { drafts, activeId: stored }
  }
  const first = drafts[0]
  if (first === undefined) throw new AppError('INTERNAL', 'No draft after creating one')
  db.delete(draftText).where(eq(draftText.draftId, first.id)).run()
  writeActiveId(db, first.id)
  return { drafts, activeId: first.id }
}

function requireDraft(state: DraftState, id: string): DraftRow {
  const found = state.drafts.find((each) => each.id === id)
  if (!found) throw new AppError('NOT_FOUND', 'Draft not found', { id })
  return found
}

/** A validated, trimmed name no other draft has (case-insensitive); VALIDATION otherwise. */
function availableName(state: DraftState, name: string, exceptId?: string): string {
  const parsed = DraftName.safeParse(name)
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'A draft name is 1 to 60 characters', {
      issues: parsed.error.issues
    })
  }
  const key = parsed.data.toLocaleLowerCase()
  const taken = state.drafts.find(
    (each) => each.id !== exceptId && each.name.toLocaleLowerCase() === key
  )
  if (taken) {
    throw new AppError('VALIDATION', `A draft named "${taken.name}" already exists`, {
      name: parsed.data
    })
  }
  return parsed.data
}

/** The stored rows of one draft, by node id. */
function rowsOf(db: TreeDb, draftId: string): Map<string, DraftText> {
  const rows = db.select().from(draftText).where(eq(draftText.draftId, draftId)).all()
  return new Map(
    rows.map((row) => [row.nodeId, { content: row.content, wordCount: row.wordCount }])
  )
}

/** The text a draft reads for `doc`: the active draft reads live; an inactive one its row, else live. */
function textOf(
  draftId: string,
  activeId: string,
  rows: ReadonlyMap<string, DraftText>,
  doc: NodeRow
): DraftText {
  const live = { content: doc.content, wordCount: doc.wordCount }
  if (draftId === activeId) return live
  return rows.get(doc.id) ?? live
}

/** A draft's rows, or none for the active draft (whose text is all live). */
function readerOf(db: TreeDb, draftId: string, activeId: string): Map<string, DraftText> {
  return draftId === activeId ? new Map<string, DraftText>() : rowsOf(db, draftId)
}

/**
 * Makes `text` the live content of document `id`. A stored JSON goes through `saveDocument` (word
 * count recounted, `modified` stamped); an empty (null) text is written as null with no words.
 */
function writeLive(db: TreeDb, id: string, text: DraftText): number {
  if (text.content === null) {
    requireDocument(db, id)
    db.update(node)
      .set({ content: null, wordCount: 0, modified: new Date().toISOString() })
      .where(eq(node.id, id))
      .run()
    return 0
  }
  return saveDocument(db, id, parseStoredTiptap(text.content, id, 'draft text')).wordCount
}

function stampModified(db: TreeDb, id: string): void {
  db.update(draft).set({ modified: new Date().toISOString() }).where(eq(draft.id, id)).run()
}

function buildList(db: TreeDb, state: DraftState, docs: NodeRow[]): DraftList {
  const all = db.select().from(draftText).all()
  const byDraft = new Map<string, Map<string, DraftText>>()
  for (const row of all) {
    let rows = byDraft.get(row.draftId)
    if (rows === undefined) {
      rows = new Map()
      byDraft.set(row.draftId, rows)
    }
    rows.set(row.nodeId, { content: row.content, wordCount: row.wordCount })
  }
  const empty = new Map<string, DraftText>()
  return {
    activeId: state.activeId,
    drafts: state.drafts.map((each) => {
      const rows = byDraft.get(each.id) ?? empty
      let wordCount = 0
      for (const doc of docs) wordCount += textOf(each.id, state.activeId, rows, doc).wordCount
      return {
        id: each.id,
        name: each.name,
        wordCount,
        active: each.id === state.activeId,
        created: each.created,
        modified: each.modified
      }
    })
  }
}

/** Every draft, oldest first, with word counts; the first use creates "Draft 1". */
export function listDrafts(db: TreeDb): DraftList {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    return buildList(tx, state, manuscriptDocuments(tx))
  })
}

/**
 * Makes `id` the active draft: the live text of every manuscript document is stored as the
 * leaving draft's rows, then each document the target has a row for takes that text live, and
 * the target's rows are dropped. `changed` lists the documents whose live text moved. Switching
 * to the active draft changes nothing.
 */
export function switchDraft(db: TreeDb, id: string): DraftChange {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    requireDraft(state, id)
    const docs = manuscriptDocuments(tx)
    if (id === state.activeId) return { list: buildList(tx, state, docs), changed: [] }

    const leaving = state.activeId
    for (const doc of docs) {
      const values = { content: doc.content, wordCount: doc.wordCount }
      tx.insert(draftText)
        .values({ draftId: leaving, nodeId: doc.id, ...values })
        .onConflictDoUpdate({ target: [draftText.draftId, draftText.nodeId], set: values })
        .run()
    }
    stampModified(tx, leaving)

    const target = rowsOf(tx, id)
    const changed: DraftChange['changed'] = []
    for (const doc of docs) {
      const text = target.get(doc.id)
      if (text === undefined || text.content === doc.content) continue
      changed.push({ id: doc.id, wordCount: writeLive(tx, doc.id, text) })
    }
    tx.delete(draftText).where(eq(draftText.draftId, id)).run()
    writeActiveId(tx, id)

    const next = { ...state, activeId: id }
    return { list: buildList(tx, next, manuscriptDocuments(tx)), changed }
  })
}

/**
 * A new, inactive draft named `name` holding the text `id` reads for every manuscript document
 * (live for the active draft). Placed last in the list; does not switch.
 */
export function duplicateDraft(db: TreeDb, id: string, name: string): DraftList {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    requireDraft(state, id)
    const clean = availableName(state, name)
    const docs = manuscriptDocuments(tx)
    const source = readerOf(tx, id, state.activeId)
    const now = new Date().toISOString()
    const newId = randomUUID()
    const position = Math.max(-1, ...state.drafts.map((each) => each.position)) + 1
    tx.insert(draft).values({ id: newId, name: clean, position, created: now, modified: now }).run()
    for (const doc of docs) {
      const text = textOf(id, state.activeId, source, doc)
      tx.insert(draftText)
        .values({ draftId: newId, nodeId: doc.id, ...text })
        .run()
    }
    return buildList(tx, ensureDrafts(tx), docs)
  })
}

/** Renames a draft; VALIDATION for a name another draft has (case-insensitive). */
export function renameDraft(db: TreeDb, id: string, name: string): DraftList {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    const row = requireDraft(state, id)
    const clean = availableName(state, name, id)
    if (clean !== row.name) {
      tx.update(draft)
        .set({ name: clean, modified: new Date().toISOString() })
        .where(eq(draft.id, id))
        .run()
    }
    return buildList(tx, ensureDrafts(tx), manuscriptDocuments(tx))
  })
}

/** Deletes an inactive draft and its texts; VALIDATION for the active draft or the last one. */
export function deleteDraft(db: TreeDb, id: string): DraftList {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    requireDraft(state, id)
    if (state.drafts.length <= 1) {
      throw new AppError('VALIDATION', 'A project keeps at least one draft', { id })
    }
    if (id === state.activeId) {
      throw new AppError('VALIDATION', 'Switch to another draft before deleting this one', { id })
    }
    tx.delete(draftText).where(eq(draftText.draftId, id)).run()
    tx.delete(draft).where(eq(draft.id, id)).run()
    return buildList(tx, ensureDrafts(tx), manuscriptDocuments(tx))
  })
}

/** The plain text of a stored document column; null reads as no text. */
function plainText(id: string, content: string | null): string {
  return content === null ? '' : docToText(parseStoredTiptap(content, id, 'draft text'))
}

/** Ancestor titles of `doc` below its section root, outermost first. */
function pathOf(byId: ReadonlyMap<string, NodeRow>, doc: NodeRow): string[] {
  const path: string[] = []
  let parent = doc.parentId === null ? undefined : byId.get(doc.parentId)
  while (parent !== undefined && parent.parentId !== null) {
    path.unshift(parent.title)
    parent = byId.get(parent.parentId)
  }
  return path
}

/**
 * The word-level differences from draft `fromId` to `toId` per manuscript document in tree
 * order. A document whose plain text reads the same in both (formatting-only differences
 * included) counts as unchanged. Read-only.
 */
export function compareDrafts(db: TreeDb, fromId: string, toId: string): DraftComparison {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    requireDraft(state, fromId)
    requireDraft(state, toId)
    const rows = listNodes(tx)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const from = readerOf(tx, fromId, state.activeId)
    const to = readerOf(tx, toId, state.activeId)
    const docs: DraftDocDiff[] = []
    let unchanged = 0
    for (const doc of manuscriptDocuments(tx, rows)) {
      const a = textOf(fromId, state.activeId, from, doc).content
      const b = textOf(toId, state.activeId, to, doc).content
      const left = a === b ? '' : plainText(doc.id, a)
      const right = a === b ? '' : plainText(doc.id, b)
      if (left === right) {
        unchanged += 1
        continue
      }
      const segments = diffWords(left, right)
      docs.push({
        nodeId: doc.id,
        title: doc.title,
        path: pathOf(byId, doc),
        segments,
        wordsAdded: diffWordCount(segments, 'add'),
        wordsRemoved: diffWordCount(segments, 'del')
      })
    }
    return { fromId, toId, docs, unchanged }
  })
}

/**
 * Takes documents of the active draft back to the text draft `fromId` reads for them: the
 * listed manuscript documents (ids that are not one are skipped), or all of them when `nodeIds`
 * is omitted. VALIDATION when `fromId` is the active draft. `changed` lists what moved.
 */
export function revertDocuments(
  db: TreeDb,
  fromId: string,
  nodeIds?: readonly string[]
): DraftChange {
  return db.transaction((tx) => {
    const state = ensureDrafts(tx)
    requireDraft(state, fromId)
    if (fromId === state.activeId) {
      throw new AppError('VALIDATION', 'Revert takes text from another draft', { fromId })
    }
    const wanted = nodeIds === undefined ? null : new Set(nodeIds)
    const source = rowsOf(tx, fromId)
    const changed: DraftChange['changed'] = []
    for (const doc of manuscriptDocuments(tx)) {
      if (wanted !== null && !wanted.has(doc.id)) continue
      const text = source.get(doc.id)
      if (text === undefined || text.content === doc.content) continue
      changed.push({ id: doc.id, wordCount: writeLive(tx, doc.id, text) })
    }
    if (changed.length > 0) stampModified(tx, state.activeId)
    return { list: buildList(tx, state, manuscriptDocuments(tx)), changed }
  })
}
