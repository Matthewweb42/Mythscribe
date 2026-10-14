import { createHash } from 'node:crypto'
import { asc, sql } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import { containsInlineTag, replaceInlineTags } from '@shared/memory/inlineTagReplace'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { draftText, node, snapshot, snapshotText } from '../../db/schema'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson } from '../../voice/profile'
import { invariantAliases } from '../recordStore'

/**
 * The conversion checks its own result before it commits (F-16.31, decision SW-D6; plan
 * `Switchover.md` §1.3). `takeConvertBefore` reads, at the transaction's start, every stored
 * document's text with each inline tag's consented words put back (`replaceInlineTags`, the same
 * words the conversion writes) and a digest of the snapshots; `checkConverted`, run inside the
 * same transaction after the last write, throws VALIDATION for any of: an inline tag left in a
 * node's content or notes or a draft's text; a document that no longer parses; prose lost, added
 * or moved (its text differs from the one read before); a snapshot changed; a name clash or a
 * record without a name. The throw rolls the whole transaction back, so the project stays v1.
 */

/** What a document read as before, and a digest of every snapshot. */
export interface ConvertBefore {
  /** Each readable document's text with the consented words in place, by its place key. */
  texts: Map<string, string>
  /** Places whose stored JSON did not parse before (left as they were, not checked). */
  unreadable: Set<string>
  snapshots: SnapshotDigest
}

interface SnapshotDigest {
  rows: number
  hash: string
}

/** One stored document: where it lives, how a problem names it, and its stored JSON. */
interface StoredPlace {
  key: string
  label: string
  stored: string | null
}

function storedPlaces(db: TreeDb): StoredPlace[] {
  const places: StoredPlace[] = []
  const titles = new Map<string, string>()
  const rows = db
    .select({ id: node.id, title: node.title, content: node.content, notes: node.notes })
    .from(node)
    .all()
  for (const row of rows) {
    titles.set(row.id, row.title)
    places.push({ key: `content:${row.id}`, label: `“${row.title}”`, stored: row.content })
    places.push({ key: `notes:${row.id}`, label: `the notes of “${row.title}”`, stored: row.notes })
  }
  const drafts = db
    .select({ draftId: draftText.draftId, nodeId: draftText.nodeId, content: draftText.content })
    .from(draftText)
    .all()
  for (const row of drafts) {
    places.push({
      key: `draft:${row.draftId}:${row.nodeId}`,
      label: `another draft of “${titles.get(row.nodeId) ?? 'a scene'}”`,
      stored: row.content
    })
  }
  return places
}

/** Every snapshot row and snapshot text, in key order, hashed: one pass, no I/O. */
function snapshotDigest(db: TreeDb): SnapshotDigest {
  const hash = createHash('sha256')
  let rows = 0
  for (const row of db.select().from(snapshot).orderBy(asc(snapshot.id)).all()) {
    hash.update(JSON.stringify(row)).update('\u0000')
    rows += 1
  }
  const texts = db
    .select()
    .from(snapshotText)
    .orderBy(asc(snapshotText.snapshotId), asc(snapshotText.nodeId))
    .all()
  for (const row of texts) {
    hash.update(JSON.stringify(row)).update('\u0000')
    rows += 1
  }
  return { rows, hash: hash.digest('hex') }
}

/**
 * What every document reads as before the conversion writes, with each token's consented words
 * (`tokenText`, by token id; a token not in it reads as its name, as the conversion writes it).
 */
export function takeConvertBefore(
  db: TreeDb,
  tokenText: ReadonlyMap<string, string>
): ConvertBefore {
  const texts = new Map<string, string>()
  const unreadable = new Set<string>()
  for (const place of storedPlaces(db)) {
    if (place.stored === null) continue
    const doc = documentJson({ content: place.stored })
    if (doc === null) unreadable.add(place.key)
    else texts.set(place.key, docToText(replaceInlineTags(doc, tokenText).doc))
  }
  return { texts, unreadable, snapshots: snapshotDigest(db) }
}

/** The most problems one message names; the rest are counted. */
const PROBLEMS_SHOWN = 3

/**
 * Throws VALIDATION (rolling the conversion back) when the converted project does not check out
 * against `before`; see the module comment. Silent when it does.
 */
export function checkConverted(db: TreeDb, before: ConvertBefore): void {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const place of storedPlaces(db)) {
    seen.add(place.key)
    const was = before.texts.get(place.key)
    if (place.stored === null) {
      if (was !== undefined) problems.push(`${place.label} lost its text`)
      continue
    }
    const doc = documentJson({ content: place.stored })
    if (doc === null) {
      if (!before.unreadable.has(place.key)) problems.push(`${place.label} no longer opens`)
      continue
    }
    if (containsInlineTag(doc)) problems.push(`${place.label} still has an inline tag`)
    if (was !== undefined && docToText(doc) !== was) {
      problems.push(`${place.label} would not read as it did`)
    }
  }
  for (const key of before.texts.keys()) {
    if (!seen.has(key)) problems.push('a document went missing')
  }
  const after = snapshotDigest(db)
  if (after.rows !== before.snapshots.rows || after.hash !== before.snapshots.hash) {
    problems.push('a snapshot changed')
  }
  for (const violation of checkMemoryInvariants({
    claims: [],
    sceneHashes: new Map(),
    aliases: invariantAliases(db),
    citations: []
  })) {
    if (violation.kind === 'aliasClash') {
      problems.push(`the name “${violation.norm}” belongs to more than one record`)
    }
  }
  const nameless = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM record r WHERE NOT EXISTS
      (SELECT 1 FROM alias a WHERE a.record_id = r.id AND a.is_main = 1)`
  )
  const unnamed = nameless?.n ?? 0
  if (unnamed > 0) {
    problems.push(`${unnamed === 1 ? 'a record' : `${unnamed} records`} would have no name`)
  }
  if (problems.length === 0) return
  const shown = problems.slice(0, PROBLEMS_SHOWN).join('; ')
  const more = problems.length - PROBLEMS_SHOWN
  throw new AppError(
    'VALIDATION',
    `its own check found that ${shown}${more > 0 ? ` (and ${more} more)` : ''}`,
    { problems }
  )
}
