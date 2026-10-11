import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import {
  buildNameIndex,
  mentionPhrase,
  scanNames,
  type NameIndex,
  type NameMention
} from '@shared/memory/nameScan'
import { recordKindOf } from '@shared/memory/records'
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
export const NAME_INDEX_VERSION = 1

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
  const records = db
    .select({ id: record.id, categoryId: record.categoryId })
    .from(record)
    .orderBy(asc(record.created), sql`rowid`)
    .all()
    .map((row) => ({ id: row.id, kind: recordKindOf(row.categoryId) }))
  const order = new Map(records.map((row, i) => [row.id, i]))
  const aliases = db
    .select()
    .from(alias)
    .orderBy(asc(alias.created), sql`rowid`)
    .all()
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

const sameMentions = (a: readonly NameMention[], b: readonly NameMention[]): boolean =>
  JSON.stringify(a.map((m) => [m.recordId, m.from, m.to, m.ambiguous])) ===
  JSON.stringify(b.map((m) => [m.recordId, m.from, m.to, m.ambiguous]))

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
 * again at once. Answers the tombstone.
 */
export function markNotAMention(db: TreeDb, mentionId: string, now: Date): Dismissed {
  const row = db.select().from(nameMention).where(eq(nameMention.id, mentionId)).get()
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That mention is no longer there', { mentionId })
  const scene = manuscriptDocuments(db).find((document) => document.id === row.nodeId)
  const doc = scene === undefined ? EMPTY_DOC : (documentJson(scene) ?? EMPTY_DOC)
  const paragraph = passageParagraphs(doc)[row.para]
  if (paragraph === undefined)
    throw new AppError('NOT_FOUND', 'That mention is no longer there', { mentionId })
  const phrase = mentionPhrase(paragraph.text, row.from - paragraph.from, row.to - paragraph.from)
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
