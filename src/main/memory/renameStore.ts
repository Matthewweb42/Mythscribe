import { and, eq } from 'drizzle-orm'
import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { DISMISSED_LABEL_MAX, DISMISSED_QUOTE_MAX } from '@shared/memory/dismissed'
import type { NameIndex, NameScanContext } from '@shared/memory/nameScan'
import {
  NO_RENAME_KEPT,
  notMentionMoves,
  planRename,
  renameSamples,
  renameSnapshotName,
  type NotMentionMove,
  type RenameApplyRequest,
  type RenameApplyResult,
  type RenameEdit,
  type RenameKept,
  type RenamePreview,
  type RenameRequest,
  type RenameTarget,
  type RenameUndoResult
} from '@shared/memory/rename'
import { replaceAtPositions } from '@shared/replace'
import { searchableText } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { dismissed, draftText } from '../db/schema'
import { parseStoredTiptap, saveDocument, writeDocumentText } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { takeAutoSnapshot } from '../snapshot/snapshotStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { dismiss, getDismissedByKey } from './dismissedStore'
import { nameScanShared } from './nameIndexer'
import {
  checkAliasRename,
  getRecord,
  renameAlias,
  requireRecord,
  restoreAliasText,
  type AliasText
} from './recordStore'
import { povOf } from './sceneDetailStore'

/**
 * Rename in book (F-16.13, story memory v2), main side: the preview and the one transaction that
 * rewrites the places the name scan reads as the record by that name (`planRename`: a longer
 * name, another record's, a span that may be someone else and a Not a mention phrase all stay),
 * in the manuscript's other scenes (`replaceAtPositions` + `saveDocument`), in every inactive
 * draft's text when the author ticks them (`draft_text`), the name itself and the Not a mention
 * keys whose phrases the rewrite changed, after an automatic snapshot. The scene open in the
 * editor is left to the renderer, which applies the same edits through the editor and keeps its
 * own undo for it. The undo here is in memory for the session (like `replaceStore`'s): a text is
 * put back only while it still reads as the rename left it.
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
  /** Rows whose key moved with the rewritten phrase, and what they were. */
  moved: {
    id: string
    before: { key: string; label: string; quote: string | null }
    afterKey: string
  }[]
  /** Rows added for a phrase the rename wrote while the old one is still written elsewhere. */
  added: { id: string; key: string }[]
}

interface RenameUndo {
  recordId: string
  aliasId: string
  name: { before: AliasText; after: AliasText }
  docs: DocUndo[]
  drafts: DraftUndo[]
  dismissed: DismissedUndo
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

/** What every text of one rename shares: the checked name, the new text and the roster's index. */
interface RenameScope {
  target: RenameTarget
  from: string
  to: string
  index: NameIndex
  notMention: ReadonlySet<string>
}

/** Runs the rename's checks (`checkAliasRename`, so the preview refuses what the apply would). */
function scopeOf(db: TreeDb, request: RenameRequest): RenameScope {
  const { current, text } = checkAliasRename(db, request.recordId, request.aliasId, request.to)
  const shared = nameScanShared(db)
  return {
    target: {
      recordId: request.recordId,
      text: current.text,
      norm: current.norm,
      caseRule: current.caseRule
    },
    from: current.text,
    to: text,
    index: shared.index,
    notMention: shared.notMention
  }
}

/** One stored text as the rename reads it: its places (those `replaceAtPositions` applies) and the rewrite. */
interface PlannedText {
  raw: string
  paragraphs: Paragraph[]
  ctx: NameScanContext
  writes: boolean
  edits: RenameEdit[]
  kept: RenameKept
  rewritten: TiptapNodeT
}

function planText(
  db: TreeDb,
  nodeId: string,
  raw: string | null,
  scope: RenameScope
): PlannedText | null {
  const doc = storedDoc(nodeId, raw)
  if (doc === null || raw === null) return null
  const paragraphs = passageParagraphs(doc)
  const ctx: NameScanContext = { povRecordId: povOf(db, nodeId), notMention: scope.notMention }
  const plan = planRename(paragraphs, scope.index, ctx, scope.target, scope.to)
  const replaced =
    plan.edits.length === 0 ? { doc, applied: [] } : replaceAtPositions(doc, plan.edits)
  return {
    raw,
    paragraphs,
    ctx,
    writes: plan.writes,
    edits: replaced.applied,
    kept: plan.kept,
    rewritten: replaced.doc
  }
}

const addKept = (a: RenameKept, b: RenameKept): RenameKept => ({
  notMention: a.notMention + b.notMention,
  unsure: a.unsure + b.unsure,
  other: a.other + b.other
})

/**
 * What a rename would change: the places per scene of the active draft in reading order (with
 * samples), the places that stay and why, and the places in the inactive drafts' own texts.
 * Runs the apply's checks, so a refused rename is refused here. Writes nothing.
 */
export function previewRename(db: TreeDb, request: RenameRequest): RenamePreview {
  const scope = scopeOf(db, request)
  const scenes: RenamePreview['scenes'] = []
  let kept = NO_RENAME_KEPT
  for (const row of manuscriptDocuments(db)) {
    const text = planText(db, row.id, row.content, scope)
    if (text === null) continue
    kept = addKept(kept, text.kept)
    if (text.edits.length === 0) continue
    scenes.push({
      nodeId: row.id,
      title: searchableText(row.title),
      count: text.edits.length,
      samples: renameSamples(text.paragraphs, text.edits)
    })
  }
  let matches = 0
  let draftScenes = 0
  for (const row of db.select().from(draftText).all()) {
    const count = planText(db, row.nodeId, row.content, scope)?.edits.length ?? 0
    if (count === 0) continue
    matches += count
    draftScenes += 1
  }
  return {
    from: scope.from,
    to: scope.to,
    scenes,
    total: scenes.reduce((sum, scene) => sum + scene.count, 0),
    kept,
    otherDrafts: { matches, scenes: draftScenes }
  }
}

/**
 * Applies a rename (F-16.13) in one transaction: an automatic project snapshot ("Before renaming
 * …") when any text changes, then every manuscript scene but `openId`, the inactive drafts' texts
 * when `otherDrafts` is ticked, the name, and the Not a mention keys whose phrases changed. The
 * previous texts become the one pending undo (replacing an earlier rename's).
 */
export function applyRename(db: TreeDb, request: RenameApplyRequest, now: Date): RenameApplyResult {
  const done = db.transaction((tx) => {
    const scope = scopeOf(tx, request)
    const scenes = manuscriptDocuments(tx).flatMap((row) => {
      const text = planText(tx, row.id, row.content, scope)
      return text === null ? [] : [{ id: row.id, text }]
    })
    const drafts = tx
      .select()
      .from(draftText)
      .all()
      .flatMap((row) => {
        const text = planText(tx, row.nodeId, row.content, scope)
        return text === null ? [] : [{ draftId: row.draftId, nodeId: row.nodeId, text }]
      })
    const draftWrites = request.otherDrafts
      ? drafts.filter(({ text }) => text.edits.length > 0)
      : []
    const sceneWrites = scenes.filter(({ text }) => text.edits.length > 0)
    // The open scene is snapshotted with the rest: the editor rewrites it a moment later. No
    // snapshot holds the inactive drafts' texts (the form says so before they are ticked).
    if (sceneWrites.length > 0 || draftWrites.length > 0) {
      takeAutoSnapshot(tx, renameSnapshotName(scope.from, scope.to))
    }
    const open = sceneWrites.find(({ id }) => id === request.openId)

    const docUndo: DocUndo[] = []
    const written: RenameApplyResult['written'] = []
    for (const { id, text } of sceneWrites) {
      if (id === request.openId) continue
      const { wordCount } = saveDocument(tx, id, text.rewritten)
      const after = getNode(tx, id)?.content
      if (after === null || after === undefined) {
        throw new AppError('INTERNAL', 'A renamed scene did not store', { id })
      }
      docUndo.push({ id, before: text.raw, after })
      written.push({ id, wordCount, count: text.edits.length })
    }

    const draftUndo: DraftUndo[] = []
    let draftMatches = 0
    for (const { draftId, nodeId, text } of draftWrites) {
      const after = JSON.stringify(text.rewritten)
      tx.update(draftText)
        .set({ content: after, wordCount: countWords(text.rewritten) })
        .where(and(eq(draftText.draftId, draftId), eq(draftText.nodeId, nodeId)))
        .run()
      draftUndo.push({ draftId, nodeId, before: text.raw, after })
      draftMatches += text.edits.length
    }

    // Every text that writes the name says which Not a mention keys it uses and how the rewrite
    // moved them (an untouched draft's keys stay as they are, so a key it still uses is kept).
    const moves: NotMentionMove[] = []
    const rewritten = new Set(draftWrites.map(({ text }) => text))
    for (const { text } of scenes) {
      if (text.writes)
        moves.push(...notMentionMoves(text.paragraphs, scope.index, text.ctx, text.edits))
    }
    for (const { text } of drafts) {
      if (!text.writes) continue
      const edits = rewritten.has(text) ? text.edits : []
      moves.push(...notMentionMoves(text.paragraphs, scope.index, text.ctx, edits))
    }

    const name = renameAlias(tx, request.recordId, request.aliasId, scope.to, now)
    return {
      undo: {
        recordId: request.recordId,
        aliasId: request.aliasId,
        name,
        docs: docUndo,
        drafts: draftUndo,
        dismissed: moveNotMentions(tx, moves, now)
      },
      written,
      draftMatches,
      openId: open === undefined ? null : open.id,
      openEdits: open?.text.edits ?? []
    }
  })
  pending = done.undo
  return {
    record: requireRecord(db, request.recordId),
    written: done.written,
    drafts: done.draftMatches,
    openId: done.openId,
    openEdits: done.openEdits
  }
}

/** A Dismissed label with its phrase rewritten (`"Hesk, Mara, and" is not a mention of Mara`). */
function relabel(label: string, quote: string | null, phrase: string): string {
  const next =
    quote !== null && quote !== '' && label.includes(quote) ? label.replace(quote, phrase) : label
  return next.slice(0, DISMISSED_LABEL_MAX)
}

/**
 * The Not a mention keys whose phrase the rewrite changed follow it, so the mark still holds in
 * the rewritten prose. A key no text still writes the old way moves (its row is rekeyed); one
 * still written the old way somewhere stays and the new phrase gets a row of its own. A key the
 * table already holds is left as it is (never deleted). Answers how to put it all back.
 */
function moveNotMentions(db: TreeDb, moves: readonly NotMentionMove[], now: Date): DismissedUndo {
  const byKey = new Map<string, { stays: boolean; after: Map<string, string> }>()
  for (const move of moves) {
    const entry = byKey.get(move.before) ?? { stays: false, after: new Map<string, string>() }
    if (move.after === move.before) entry.stays = true
    else if (!entry.after.has(move.after)) entry.after.set(move.after, move.phrase)
    byKey.set(move.before, entry)
  }
  const undo: DismissedUndo = { moved: [], added: [] }
  for (const [key, entry] of byKey) {
    if (entry.after.size === 0) continue
    const row = db
      .select()
      .from(dismissed)
      .where(and(eq(dismissed.kind, 'notMention'), eq(dismissed.key, key)))
      .get()
    if (row === undefined) continue
    const fresh = [...entry.after].filter(
      ([after]) => getDismissedByKey(db, 'notMention', after) === null
    )
    let adds = fresh
    const first = fresh[0]
    if (!entry.stays && first !== undefined) {
      const [afterKey, phrase] = first
      db.update(dismissed)
        .set({
          key: afterKey,
          label: relabel(row.label, row.quote, phrase),
          quote: phrase.slice(0, DISMISSED_QUOTE_MAX)
        })
        .where(eq(dismissed.id, row.id))
        .run()
      undo.moved.push({
        id: row.id,
        before: { key: row.key, label: row.label, quote: row.quote },
        afterKey
      })
      adds = fresh.slice(1)
    }
    for (const [afterKey, phrase] of adds) {
      const added = dismiss(
        db,
        {
          kind: 'notMention',
          key: afterKey,
          recordId: row.recordId,
          nodeId: row.nodeId,
          label: relabel(row.label, row.quote, phrase),
          quote: phrase
        },
        now
      )
      undo.added.push({ id: added.id, key: afterKey })
    }
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
    for (const row of entry.dismissed.added) {
      const current = tx.select().from(dismissed).where(eq(dismissed.id, row.id)).get()
      if (current?.key === row.key) tx.delete(dismissed).where(eq(dismissed.id, row.id)).run()
    }
    for (const row of entry.dismissed.moved) {
      const current = tx.select().from(dismissed).where(eq(dismissed.id, row.id)).get()
      if (current?.key !== row.afterKey) continue
      if (getDismissedByKey(tx, 'notMention', row.before.key) !== null) continue
      tx.update(dismissed).set(row.before).where(eq(dismissed.id, row.id)).run()
    }
    return { restored, skipped, drafts, nameRestored }
  })
  pending = null
  return { record: getRecord(db, entry.recordId), ...result }
}
