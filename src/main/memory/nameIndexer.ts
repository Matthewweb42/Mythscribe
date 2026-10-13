import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, sql } from 'drizzle-orm'
import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import {
  buildNameIndex,
  mentionPhrase,
  scanNames,
  type NamedInRow,
  type NameIndex,
  type NameMention
} from '@shared/memory/nameScan'
import type { RecordKind } from '@shared/memory/records'
import { recordKindOf } from '@shared/memory/records'
import { isNamedKind } from '@shared/memory/topics'
import { EMPTY_DOC } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import { alias, nameMention, record, type NameMentionRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../voice/profile'
import { dismiss, dismissedKeys } from './dismissedStore'
import { getRecord, rosterHash } from './recordStore'
import { getScanHashes, scanHashesOf, setScanHash } from './scanStore'
import { povOf } from './sceneDetailStore'

/**
 * The name index (F-16.5): the one writer of `name_mention`. After a save, the mention queue
 * runs `scanNamesFor` over the saved scene (the active draft's text, every status, so the Book
 * can filter Idea and excluded scenes later) and replaces its rows. Local and silent: no AI,
 * nothing sent. Invalidation is by hash (CLAUDE.md, token rule 4): the scene's text, the roster
 * (`rosterHash`), the Not a mention list, the typed POV and `NAME_INDEX_VERSION`. A roster change
 * (a name added, removed or renamed) makes every scene stale, as a tag rename does in v1.
 */

/** Bumped when what a scan writes changes, so every scene is scanned once more. */
export const NAME_INDEX_VERSION = 2

/** What every scan of one pass shares: the roster's index and the hashes that stand for it. */
export interface NameScanShared {
  index: NameIndex
  rosterHash: string
  notMention: Set<string>
  notMentionHash: string
}

export function nameScanShared(db: TreeDb): NameScanShared {
  // Roster order (records as they were made, names as they were added) is the order an
  // ambiguous span lists its possible owners in.
  // P2b-D2: secrets and threads are not names: their labels never make a mention.
  const records = db
    .select({ id: record.id, categoryId: record.categoryId })
    .from(record)
    .orderBy(asc(record.created), sql`rowid`)
    .all()
    .map((row) => ({ id: row.id, kind: recordKindOf(row.categoryId) }))
    .filter((row) => isNamedKind(row.kind))
  const order = new Map(records.map((row, i) => [row.id, i]))
  const aliases = db
    .select()
    .from(alias)
    .orderBy(asc(alias.created), sql`rowid`)
    .all()
    .filter((row) => order.has(row.recordId))
    .sort((a, b) => (order.get(a.recordId) ?? 0) - (order.get(b.recordId) ?? 0))
    .map((row) => ({
      id: row.id,
      recordId: row.recordId,
      text: row.text,
      norm: row.norm,
      caseRule: row.caseRule,
      shared: row.shared
    }))
  const notMention = dismissedKeys(db, 'notMention')
  return {
    index: buildNameIndex(records, aliases),
    rosterHash: rosterHash(db),
    notMention,
    notMentionHash: sha256(JSON.stringify([...notMention].sort()))
  }
}

interface NameSource {
  paragraphs: Paragraph[]
  pov: string | null
  hash: string
}

function sourceOf(
  db: TreeDb,
  row: { id: string; content: string | null },
  shared: NameScanShared
): NameSource {
  const paragraphs = passageParagraphs(documentJson(row) ?? EMPTY_DOC)
  const pov = povOf(db, row.id)
  const hash = sha256(
    JSON.stringify({
      v: NAME_INDEX_VERSION,
      texts: paragraphs.map((paragraph) => [paragraph.from, paragraph.text]),
      roster: shared.rosterHash,
      notMention: shared.notMentionHash,
      pov
    })
  )
  return { paragraphs, pov, hash }
}

const toMention = (row: NameMentionRow): NameMention & { id: string } => ({
  id: row.id,
  recordId: row.recordId,
  para: row.para,
  from: row.from,
  to: row.to,
  text: row.text,
  ambiguous: row.ambiguous,
  spanKey: row.spanKey
})

/** A scene's recorded mentions, in document order. */
export function listNameMentions(db: TreeDb, nodeId: string): (NameMention & { id: string })[] {
  return db
    .select()
    .from(nameMention)
    .where(eq(nameMention.nodeId, nodeId))
    .orderBy(asc(nameMention.from), asc(nameMention.to), sql`rowid`)
    .all()
    .map(toMention)
}

/**
 * How often each scene names each record, certain mentions only (an ambiguous span names nobody
 * yet): one row per record and scene, by record then scene id. What *Named in* and the lists'
 * "named in N scenes" read. Only scenes in the manuscript count: a scene moved to front or end
 * matter keeps its rows (the scan skips it, and its hash still holds should it come back), but it
 * is not named in the book.
 */
export function namedInCounts(db: TreeDb): NamedInRow[] {
  const manuscript = sql`WITH RECURSIVE book(id) AS (
      SELECT id FROM node WHERE parent_id IS NULL AND section_type = 'manuscript'
      UNION SELECT node.id FROM node JOIN book ON node.parent_id = book.id
    ) SELECT id FROM book`
  return db
    .select({
      recordId: nameMention.recordId,
      nodeId: nameMention.nodeId,
      count: count()
    })
    .from(nameMention)
    .where(and(eq(nameMention.ambiguous, false), sql`${nameMention.nodeId} IN (${manuscript})`))
    .groupBy(nameMention.recordId, nameMention.nodeId)
    .orderBy(asc(nameMention.recordId), asc(nameMention.nodeId))
    .all()
}

/**
 * How often the book names each record in all, certain mentions only (`namedInCounts` summed per
 * record): the roster cap's cut and the who-knows-what grid's column order (F-16.22) read it.
 */
export function namedTotals(db: TreeDb): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of namedInCounts(db)) {
    totals.set(row.recordId, (totals.get(row.recordId) ?? 0) + row.count)
  }
  return totals
}

/**
 * Every record the name index holds, with its kind, as the memory invariants read it (P2b's
 * `topicName`): the scan's roster and every record a stored mention names.
 */
export function invariantIndexed(db: TreeDb): { recordId: string; kind: RecordKind }[] {
  const roster = [...nameScanShared(db).index.kinds].map(([recordId, kind]) => ({ recordId, kind }))
  const mentioned = db
    .selectDistinct({ recordId: nameMention.recordId, categoryId: record.categoryId })
    .from(nameMention)
    .innerJoin(record, eq(record.id, nameMention.recordId))
    .all()
    .map((row) => ({ recordId: row.recordId, kind: recordKindOf(row.categoryId) }))
  return [...roster, ...mentioned]
}

/** Every stored field but the row id, so a shifted paragraph or a new spelling rewrites the rows. */
const mentionKey = (m: NameMention): unknown[] => [
  m.recordId,
  m.para,
  m.from,
  m.to,
  m.text,
  m.ambiguous,
  m.spanKey
]

const sameMentions = (a: readonly NameMention[], b: readonly NameMention[]): boolean =>
  JSON.stringify(a.map(mentionKey)) === JSON.stringify(b.map(mentionKey))

/**
 * Scans one manuscript document and replaces its rows. A hash that still matches writes nothing;
 * `changed` says whether the mentions themselves moved, `scanned` whether the hash had. A node
 * that is not a manuscript document throws NOT_FOUND (quiet for the queue).
 */
export function scanNamesFor(
  db: TreeDb,
  nodeId: string,
  now: Date,
  shared: NameScanShared = nameScanShared(db)
): { changed: boolean; scanned: boolean } {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Not a manuscript document', { nodeId })
  const source = sourceOf(db, row, shared)
  if (getScanHashes(db, 'scene', nodeId).namesHash === source.hash) {
    return { changed: false, scanned: false }
  }
  const found = scanNames(source.paragraphs, shared.index, {
    povRecordId: source.pov,
    notMention: shared.notMention
  })
  const changed = !sameMentions(listNameMentions(db, nodeId), found)
  db.transaction((tx) => {
    if (changed) {
      tx.delete(nameMention).where(eq(nameMention.nodeId, nodeId)).run()
      for (const mention of found) {
        tx.insert(nameMention)
          .values({ id: randomUUID(), nodeId, ...mention })
          .run()
      }
    }
    setScanHash(tx, 'scene', nodeId, 'names', source.hash, now)
  })
  return { changed, scanned: true }
}

/** The manuscript documents whose name scan is out of date, in reading order. */
export function staleNameScans(db: TreeDb): string[] {
  const shared = nameScanShared(db)
  const hashes = scanHashesOf(db, 'scene')
  return manuscriptDocuments(db)
    .filter((row) => hashes.get(row.id)?.namesHash !== sourceOf(db, row, shared).hash)
    .map((row) => row.id)
}

/**
 * *Not a mention*: the phrase around a recorded mention (the span with a word either side) is
 * never a mention of that record again (a `notMention` dismissal), and the scene is scanned
 * again at once. Answers the tombstone. A row the saved text has moved past (the scene was saved
 * after its last scan, so the words at its range are no longer its words) is refused with
 * NOT_FOUND: that save queued a scan, which rewrites the rows and tells the windows.
 */
export function markNotAMention(db: TreeDb, mentionId: string, now: Date): Dismissed {
  const row = db.select().from(nameMention).where(eq(nameMention.id, mentionId)).get()
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That mention is no longer there', { mentionId })
  const scene = manuscriptDocuments(db).find((document) => document.id === row.nodeId)
  const doc = scene === undefined ? EMPTY_DOC : (documentJson(scene) ?? EMPTY_DOC)
  const paragraph = passageParagraphs(doc)[row.para]
  if (paragraph === undefined)
    throw new AppError('NOT_FOUND', 'That mention moved. Try again.', { mentionId })
  const start = row.from - paragraph.from
  const end = row.to - paragraph.from
  if (paragraph.text.slice(start, end) !== row.text) {
    throw new AppError('NOT_FOUND', 'That mention moved. Try again.', { mentionId })
  }
  const phrase = mentionPhrase(paragraph.text, start, end)
  const name = getRecord(db, row.recordId)?.name ?? row.text
  const tombstone = dismiss(
    db,
    {
      kind: 'notMention',
      key: dismissedKey({ kind: 'notMention', recordId: row.recordId, phrase }),
      recordId: row.recordId,
      nodeId: row.nodeId,
      label: `"${phrase}" is not a mention of ${name}`,
      quote: phrase
    },
    now
  )
  scanNamesFor(db, row.nodeId, now)
  return tombstone
}
