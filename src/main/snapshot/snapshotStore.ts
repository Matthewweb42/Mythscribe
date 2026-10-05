import { randomUUID } from 'node:crypto'
import { count, desc, eq, sql, sum } from 'drizzle-orm'
import type { DraftChange, DraftDocDiff } from '@shared/drafts'
import {
  SNAPSHOT_AUTO_KEEP,
  SnapshotName,
  SnapshotNote,
  autoSnapshotName,
  type SnapshotComparison,
  type SnapshotKind,
  type SnapshotList,
  type SnapshotRestore,
  type SnapshotScope,
  type TakeSnapshot,
  type UpdateSnapshot
} from '@shared/snapshots'
import { node, snapshot, snapshotText, type NodeRow, type SnapshotRow } from '../db/schema'
import { requireDocument, writeDocumentText, type StoredText } from '../document/documentStore'
import { activeDraftName, diffDocument } from '../draft/draftStore'
import { AppError } from '../ipc/errors'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { projectDocuments } from '../voice/profile'

/**
 * Snapshots (F-8.6): frozen copies of document text, of one document or of every document in
 * the project (`projectDocuments`: front matter, the manuscript, end matter, in tree order). The
 * text taken is the live `node.content`, i.e. the active draft's; the active draft's name is
 * recorded for context. A snapshot holds a `snapshot_text` row per document it took; a document
 * deleted since drops out (cascade), and a document snapshot goes with its document.
 *
 * Every operation runs in one transaction. A restore first keeps the text it is about to
 * overwrite as an `auto` snapshot, writes through `writeDocumentText` (as a draft revert does),
 * and prunes the autos beyond `SNAPSHOT_AUTO_KEEP`; the caller follows up with
 * `documentsWritten` and never `recordWriting` (a restore is not words written).
 */

/** Newest first; rowid breaks a tie between two snapshots taken in the same millisecond. */
const NEWEST_FIRST = [desc(snapshot.created), desc(sql`${snapshot}.rowid`)] as const

function requireSnapshot(db: TreeDb, id: string): SnapshotRow {
  const row = db.select().from(snapshot).where(eq(snapshot.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', 'Snapshot not found', { id })
  return row
}

function cleanName(name: string): string {
  const parsed = SnapshotName.safeParse(name)
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'A snapshot name is 1 to 80 characters', {
      issues: parsed.error.issues
    })
  }
  return parsed.data
}

function cleanNote(note: string): string {
  const parsed = SnapshotNote.safeParse(note)
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'A snapshot note is at most 2000 characters', {
      issues: parsed.error.issues
    })
  }
  return parsed.data
}

/** One snapshot's texts, by node id. */
function textsOf(db: TreeDb, snapshotId: string): Map<string, StoredText> {
  const rows = db.select().from(snapshotText).where(eq(snapshotText.snapshotId, snapshotId)).all()
  return new Map(
    rows.map((row) => [row.nodeId, { content: row.content, wordCount: row.wordCount }])
  )
}

/** Stores a new snapshot of `docs`' live text and returns its id. */
function insertSnapshot(
  db: TreeDb,
  values: {
    name: string
    note: string
    kind: SnapshotKind
    scope: SnapshotScope
    nodeId: string | null
  },
  docs: readonly NodeRow[]
): string {
  const id = randomUUID()
  db.insert(snapshot)
    .values({
      id,
      ...values,
      draftName: activeDraftName(db),
      created: new Date().toISOString()
    })
    .run()
  for (const doc of docs) {
    db.insert(snapshotText)
      .values({ snapshotId: id, nodeId: doc.id, content: doc.content, wordCount: doc.wordCount })
      .run()
  }
  return id
}

function buildList(db: TreeDb): SnapshotList {
  const totals = new Map(
    db
      .select({
        id: snapshotText.snapshotId,
        docCount: count(),
        wordCount: sum(snapshotText.wordCount).mapWith(Number)
      })
      .from(snapshotText)
      .groupBy(snapshotText.snapshotId)
      .all()
      .map((row) => [row.id, row])
  )
  return db
    .select({ row: snapshot, nodeTitle: node.title })
    .from(snapshot)
    .leftJoin(node, eq(node.id, snapshot.nodeId))
    .orderBy(...NEWEST_FIRST)
    .all()
    .map(({ row, nodeTitle }) => {
      const total = totals.get(row.id)
      return {
        id: row.id,
        name: row.name,
        note: row.note,
        kind: row.kind,
        scope: row.scope,
        nodeId: row.nodeId,
        nodeTitle: row.nodeId === null ? null : nodeTitle,
        draftName: row.draftName,
        docCount: total?.docCount ?? 0,
        wordCount: total?.wordCount ?? 0,
        created: row.created
      }
    })
}

/** Every snapshot of the project, newest first, with document and word counts. */
export function listSnapshots(db: TreeDb): SnapshotList {
  return db.transaction((tx) => buildList(tx))
}

/**
 * Takes a snapshot of one document's live text (NOT_FOUND for an unknown id, VALIDATION for a
 * folder) or of every document in the project. `milestone` makes it a milestone, else manual.
 */
export function takeSnapshot(db: TreeDb, input: TakeSnapshot): SnapshotList {
  return db.transaction((tx) => {
    const name = cleanName(input.name)
    const note = cleanNote(input.note)
    const kind = input.milestone ? 'milestone' : 'manual'
    if (input.scope === 'document') {
      const doc = requireDocument(tx, input.nodeId)
      insertSnapshot(tx, { name, note, kind, scope: 'document', nodeId: doc.id }, [doc])
    } else {
      insertSnapshot(tx, { name, note, kind, scope: 'project', nodeId: null }, projectDocuments(tx))
    }
    return buildList(tx)
  })
}

/**
 * Renames a snapshot, edits its note, or flags it: `milestone: true` makes it a milestone,
 * `false` turns a milestone back into a manual snapshot (an automatic one stays automatic).
 */
export function updateSnapshot(db: TreeDb, input: UpdateSnapshot): SnapshotList {
  return db.transaction((tx) => {
    const row = requireSnapshot(tx, input.id)
    let kind = row.kind
    if (input.milestone === true) kind = 'milestone'
    else if (input.milestone === false && row.kind === 'milestone') kind = 'manual'
    tx.update(snapshot)
      .set({
        name: input.name === undefined ? row.name : cleanName(input.name),
        note: input.note === undefined ? row.note : cleanNote(input.note),
        kind
      })
      .where(eq(snapshot.id, row.id))
      .run()
    return buildList(tx)
  })
}

/** Deletes a snapshot and its texts. */
export function deleteSnapshot(db: TreeDb, id: string): SnapshotList {
  return db.transaction((tx) => {
    requireSnapshot(tx, id)
    tx.delete(snapshotText).where(eq(snapshotText.snapshotId, id)).run()
    tx.delete(snapshot).where(eq(snapshot.id, id)).run()
    return buildList(tx)
  })
}

/**
 * The word-level differences from snapshot `id` to snapshot `againstId`, or to the current text
 * when `againstId` is omitted, per document either snapshot holds, in tree order. A side with no
 * copy of a document reads its current text. Read-only.
 */
export function compareSnapshot(db: TreeDb, id: string, againstId?: string): SnapshotComparison {
  return db.transaction((tx) => {
    requireSnapshot(tx, id)
    if (againstId !== undefined) requireSnapshot(tx, againstId)
    const from = textsOf(tx, id)
    const to = againstId === undefined ? new Map<string, StoredText>() : textsOf(tx, againstId)
    const rows = listNodes(tx)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const docs: DraftDocDiff[] = []
    let unchanged = 0
    for (const doc of projectDocuments(tx, rows)) {
      const a = from.get(doc.id)
      const b = to.get(doc.id)
      if (a === undefined && b === undefined) continue
      const diff = diffDocument(byId, doc, (a ?? doc).content, (b ?? doc).content)
      if (diff === null) unchanged += 1
      else docs.push(diff)
    }
    return { snapshotId: id, againstId: againstId ?? null, docs, unchanged }
  })
}

/** Deletes the automatic snapshots beyond the newest `SNAPSHOT_AUTO_KEEP`, never `keepId`. */
function pruneAutos(db: TreeDb, keepId: string): void {
  const autos = db
    .select({ id: snapshot.id })
    .from(snapshot)
    .where(eq(snapshot.kind, 'auto'))
    .orderBy(...NEWEST_FIRST)
    .all()
  for (const { id } of autos.slice(SNAPSHOT_AUTO_KEEP)) {
    if (id === keepId) continue
    db.delete(snapshotText).where(eq(snapshotText.snapshotId, id)).run()
    db.delete(snapshot).where(eq(snapshot.id, id)).run()
  }
}

/**
 * Takes documents back to snapshot `id`'s text: the listed ones (ids it holds no copy of are
 * skipped), or every document it holds. The documents whose live text differs are first kept as
 * an `auto` snapshot ("Before restoring …"; document scope when there is one, else project),
 * then rewritten; older autos beyond the keep limit are pruned. Nothing differs, nothing is
 * taken. `changed` lists the rewritten documents with their new word counts.
 */
export function restoreSnapshot(
  db: TreeDb,
  id: string,
  nodeIds?: readonly string[]
): SnapshotRestore {
  return db.transaction((tx) => {
    const row = requireSnapshot(tx, id)
    const texts = textsOf(tx, id)
    const wanted = nodeIds === undefined ? null : new Set(nodeIds)
    const moving: { doc: NodeRow; text: StoredText }[] = []
    for (const doc of projectDocuments(tx)) {
      if (wanted !== null && !wanted.has(doc.id)) continue
      const text = texts.get(doc.id)
      if (text === undefined || text.content === doc.content) continue
      moving.push({ doc, text })
    }
    const changed: DraftChange['changed'] = []
    const only = moving.length === 1 ? moving[0] : undefined
    if (moving.length > 0) {
      const autoId = insertSnapshot(
        tx,
        {
          name: autoSnapshotName(row.name),
          note: '',
          kind: 'auto',
          scope: only === undefined ? 'project' : 'document',
          nodeId: only === undefined ? null : only.doc.id
        },
        moving.map((each) => each.doc)
      )
      for (const { doc, text } of moving) {
        changed.push({ id: doc.id, wordCount: writeDocumentText(tx, doc.id, text) })
      }
      pruneAutos(tx, autoId)
    }
    return { snapshots: buildList(tx), changed }
  })
}
