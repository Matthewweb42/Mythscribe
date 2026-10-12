import { and, eq } from 'drizzle-orm'
import {
  renameMatch,
  renamedPhraseKey,
  renameSnapshotName,
  type RenameApplyRequest,
  type RenameApplyResult,
  type RenamePreview,
  type RenameRequest,
  type RenameUndoResult
} from '@shared/memory/rename'
import { DISMISSED_LABEL_MAX, DISMISSED_QUOTE_MAX } from '@shared/memory/dismissed'
import { countInDoc, findInRun, replaceInDoc, type ReplaceOptions } from '@shared/replace'
import { searchableText } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { dismissed, draftText } from '../db/schema'
import { parseStoredTiptap, saveDocument, writeDocumentText } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { takeAutoSnapshot } from '../snapshot/snapshotStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  getRecord,
  renameAlias,
  requireAlias,
  requireRecord,
  restoreAliasText,
  type AliasText
} from './recordStore'

/**
 * Rename in book (F-16.13, story memory v2), main side: the preview counts and the one
 * transaction that rewrites the manuscript's other scenes (`replaceInDoc` + `saveDocument`, as
 * Replace in project does), every inactive draft's text (`draft_text`), the name itself and the
 * Not a mention keys that hold it, after an automatic snapshot. The scene open in the editor is
 * left to the renderer, which applies the same `match` through the editor and keeps its own undo
 * for it. The undo here is in memory for the session (like `replaceStore`'s): a text is put back
 * only while it still reads as the rename left it.
 */

interface DocUndo {
  id: string
  before: string
  after: string
}

interface DraftUndo {
  draftId: string
  nodeId: string
  before: string
  after: string
}

interface DismissedUndo {
  id: string
  before: { key: string; label: string; quote: string | null }
  afterKey: string
}

interface RenameUndo {
  recordId: string
  aliasId: string
  name: { before: AliasText; after: AliasText }
  docs: DocUndo[]
  drafts: DraftUndo[]
  dismissed: DismissedUndo[]
}

let pending: RenameUndo | null = null

/** Forgets the last rename's undo (a project closed or another opened). */
export function clearRenameUndo(): void {
  pending = null
}

/** Whether a rename can still be undone. For tests. */
export function hasRenameUndo(): boolean {
  return pending !== null
}

/** A stored text as a document, or null for an empty or unreadable one (left alone). */
function storedDoc(id: string, raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    return parseStoredTiptap(raw, id, 'document content')
  } catch {
    return null
  }
}

/** The matching rule for the request, after checking the record and the name exist. */
function matchOf(db: TreeDb, request: RenameRequest): { options: ReplaceOptions; from: string } {
  const name = requireAlias(db, request.recordId, request.aliasId)
  return { options: renameMatch(name, request.to), from: name.text }
}

/**
 * What a rename would change: the matches per scene of the active draft in reading order, and
 * the matches in the inactive drafts' own texts. Writes nothing.
 */
export function previewRename(db: TreeDb, request: RenameRequest): RenamePreview {
  const { options, from } = matchOf(db, request)
  const scenes: RenamePreview['scenes'] = []
  for (const row of manuscriptDocuments(db)) {
    const doc = storedDoc(row.id, row.content)
    const count = doc === null ? 0 : countInDoc(doc, options)
    if (count > 0) scenes.push({ nodeId: row.id, title: searchableText(row.title), count })
  }
  let matches = 0
  let draftScenes = 0
  for (const row of db.select().from(draftText).all()) {
    const doc = storedDoc(row.nodeId, row.content)
    const count = doc === null ? 0 : countInDoc(doc, options)
    if (count === 0) continue
    matches += count
    draftScenes += 1
  }
  return {
    from,
    to: options.replacement,
    scenes,
    total: scenes.reduce((sum, scene) => sum + scene.count, 0),
    otherDrafts: { matches, scenes: draftScenes }
  }
}

/** Replaces the rule's query in a plain string (a Dismissed row's label or quote). */
function replaceInText(text: string, options: ReplaceOptions): string {
  const found = findInRun(text, options)
  let out = text
  for (let index = found.length - 1; index >= 0; index--) {
    const range = found[index]
    if (range === undefined) continue
    out = `${out.slice(0, range[0])}${options.replacement}${out.slice(range[1])}`
  }
  return out
}

/**
 * Applies a rename (F-16.13) in one transaction: an automatic project snapshot ("Before renaming
 * …") when the active draft writes the name, then every manuscript scene but `openId`, every
 * inactive draft's text, the name, and every Not a mention key whose phrase holds the old name.
 * The previous texts become the one pending undo (replacing an earlier rename's).
 */
export function applyRename(db: TreeDb, request: RenameApplyRequest, now: Date): RenameApplyResult {
  const { options, from } = matchOf(db, request)
  const undo = db.transaction(
    (
      tx
    ): RenameUndo & {
      written: RenameApplyResult['written']
      draftMatches: number
      openId: string | null
    } => {
      const docs = manuscriptDocuments(tx)
      const writes = docs.flatMap((row) => {
        const doc = storedDoc(row.id, row.content)
        if (doc === null || row.content === null) return []
        const replaced = replaceInDoc(doc, options)
        return replaced.count === 0 ? [] : [{ row, content: row.content, replaced }]
      })
      // The open scene is snapshotted with the rest: the editor rewrites it a moment later.
      if (writes.length > 0) takeAutoSnapshot(tx, renameSnapshotName(from, options.replacement))
      const openId = writes.some(({ row }) => row.id === request.openId) ? request.openId : null

      const docUndo: DocUndo[] = []
      const written: RenameApplyResult['written'] = []
      for (const { row, content, replaced } of writes) {
        if (row.id === request.openId) continue
        const { wordCount } = saveDocument(tx, row.id, replaced.doc)
        const after = getNode(tx, row.id)?.content
        if (after === null || after === undefined) {
          throw new AppError('INTERNAL', 'A renamed scene did not store', { id: row.id })
        }
        docUndo.push({ id: row.id, before: content, after })
        written.push({ id: row.id, wordCount, count: replaced.count })
      }

      const draftUndo: DraftUndo[] = []
      let draftMatches = 0
      for (const row of tx.select().from(draftText).all()) {
        const doc = storedDoc(row.nodeId, row.content)
        if (doc === null || row.content === null) continue
        const replaced = replaceInDoc(doc, options)
        if (replaced.count === 0) continue
        const after = JSON.stringify(replaced.doc)
        tx.update(draftText)
          .set({ content: after, wordCount: countWords(replaced.doc) })
          .where(and(eq(draftText.draftId, row.draftId), eq(draftText.nodeId, row.nodeId)))
          .run()
        draftUndo.push({ draftId: row.draftId, nodeId: row.nodeId, before: row.content, after })
        draftMatches += replaced.count
      }

      const name = renameAlias(tx, request.recordId, request.aliasId, request.to, now)
      const dismissedUndo = rekeyNotMentions(tx, name.before.norm, name.after.norm, options)
      return {
        recordId: request.recordId,
        aliasId: request.aliasId,
        name,
        docs: docUndo,
        drafts: draftUndo,
        dismissed: dismissedUndo,
        written,
        draftMatches,
        openId
      }
    }
  )
  pending = {
    recordId: undo.recordId,
    aliasId: undo.aliasId,
    name: undo.name,
    docs: undo.docs,
    drafts: undo.drafts,
    dismissed: undo.dismissed
  }
  return {
    record: requireRecord(db, request.recordId),
    match: options,
    written: undo.written,
    drafts: undo.draftMatches,
    openId: undo.openId
  }
}

/**
 * Every Not a mention key (any record's) whose phrase holds the old name as a whole word, rewritten
 * to the new one, with its label and quote; a key that would collide with one already kept is
 * dropped as the duplicate it has become. Answers how to put each back.
 */
function rekeyNotMentions(
  db: TreeDb,
  fromNorm: string,
  toNorm: string,
  options: ReplaceOptions
): DismissedUndo[] {
  const rows = db.select().from(dismissed).where(eq(dismissed.kind, 'notMention')).all()
  const taken = new Set(rows.map((row) => row.key))
  const undo: DismissedUndo[] = []
  for (const row of rows) {
    const key = renamedPhraseKey(row.key, fromNorm, toNorm)
    if (key === null || key === row.key) continue
    if (taken.has(key)) {
      db.delete(dismissed).where(eq(dismissed.id, row.id)).run()
      continue
    }
    taken.delete(row.key)
    taken.add(key)
    db.update(dismissed)
      .set({
        key,
        label: replaceInText(row.label, options).slice(0, DISMISSED_LABEL_MAX),
        quote:
          row.quote === null
            ? null
            : replaceInText(row.quote, options).slice(0, DISMISSED_QUOTE_MAX)
      })
      .where(eq(dismissed.id, row.id))
      .run()
    undo.push({
      id: row.id,
      before: { key: row.key, label: row.label, quote: row.quote },
      afterKey: key
    })
  }
  return undo
}

/**
 * Takes the last rename back in one transaction (F-16.13): each scene, draft text, name and
 * Dismissed key only while it still reads as the rename left it; a scene edited since (or gone)
 * is skipped and named. The undo is spent either way. The open scene is the renderer's.
 */
export function undoRename(db: TreeDb, now: Date): RenameUndoResult {
  const entry = pending
  if (entry === null) throw new AppError('VALIDATION', 'There is no rename to undo')
  const result = db.transaction((tx) => {
    const restored: RenameUndoResult['restored'] = []
    const skipped: RenameUndoResult['skipped'] = []
    for (const doc of entry.docs) {
      const row = getNode(tx, doc.id)
      if (row?.kind !== 'document' || row.content !== doc.after) {
        skipped.push({
          id: doc.id,
          title: row === undefined ? 'A deleted scene' : searchableText(row.title)
        })
        continue
      }
      restored.push({
        id: doc.id,
        wordCount: writeDocumentText(tx, doc.id, { content: doc.before, wordCount: 0 })
      })
    }
    const drafts = { restored: 0, skipped: 0 }
    for (const text of entry.drafts) {
      const where = and(eq(draftText.draftId, text.draftId), eq(draftText.nodeId, text.nodeId))
      const row = tx.select().from(draftText).where(where).get()
      const before = storedDoc(text.nodeId, text.before)
      if (row?.content !== text.after || before === null) {
        drafts.skipped += 1
        continue
      }
      tx.update(draftText)
        .set({ content: text.before, wordCount: countWords(before) })
        .where(where)
        .run()
      drafts.restored += 1
    }
    const nameRestored = restoreAliasText(
      tx,
      entry.aliasId,
      entry.name.after.text,
      entry.name.before,
      now
    )
    for (const row of entry.dismissed) {
      const current = tx.select().from(dismissed).where(eq(dismissed.id, row.id)).get()
      if (current?.key !== row.afterKey) continue
      const clash = tx
        .select({ id: dismissed.id })
        .from(dismissed)
        .where(and(eq(dismissed.kind, 'notMention'), eq(dismissed.key, row.before.key)))
        .get()
      if (clash !== undefined) continue
      tx.update(dismissed).set(row.before).where(eq(dismissed.id, row.id)).run()
    }
    return { restored, skipped, drafts, nameRestored }
  })
  pending = null
  return { record: getRecord(db, entry.recordId), ...result }
}
