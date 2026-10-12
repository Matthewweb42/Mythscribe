import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { CardFields, CardPresent, ClaimPending } from '@shared/memory/claims'
import { docToText } from '@shared/docText'
import { normName } from '@shared/memory/names'
import { isTopicCategory } from '@shared/memory/topics'
import { TiptapNode } from '@shared/tiptap'
import { card, claim, knewBefore, memoryBackfill, record, topicQuote } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The reading's evidence when records merge or split (F-16.4's *Same as…* and *Split*, F-16.17;
 * plan P2a §1.4), inside the record store's transaction:
 * - a merge re-points every claim (subject, object, speaker, source, and the candidates a claim
 *   waiting on its subject names), each card's on-page records and verified POV, and the
 *   back-fill rows from the merged record to the kept one;
 * - a split moves the claims whose subject was pinned by a moved name (`subject_text`), and the
 *   card's on-page entries and POV whose quote names the record only by a moved name; claims with
 *   a pronoun subject stay with the record. An object or speaker has no name span stored, so it
 *   stays (the next reading of that scene corrects it).
 * A deleted record's claims go with it (foreign keys); a card's on-page entry for a record that
 * is gone is left out when it is read. P2b: a merge also re-points the author's *Knew before the
 * book* rows (both ends, a pair the kept record already has dropped) and the secrets' and threads'
 * reveals; a deleted secret takes the knows claims about it (`deleteKnowsAbout`: their object
 * would be cleared, leaving orphans), and an AI-made topic nothing backs any more is found by
 * `emptyTopics` for the record store to prune (P2b-D12).
 */

const Present = z.array(CardPresent)

/** A card's on-page records and fields, or null when either no longer parses (left alone). */
function parseCard(
  present: string,
  fields: string
): { present: z.infer<typeof Present>; fields: z.infer<typeof CardFields> } | null {
  try {
    const parsedPresent = Present.safeParse(JSON.parse(present))
    const parsedFields = CardFields.safeParse(JSON.parse(fields))
    return parsedPresent.success && parsedFields.success
      ? { present: parsedPresent.data, fields: parsedFields.data }
      : null
  } catch {
    return null
  }
}

function parsePending(raw: string | null): ClaimPending | null {
  if (raw === null) return null
  try {
    const parsed = ClaimPending.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The quote's words as names are compared (`normName` per word), padded for whole-word search. */
function quoteWords(quote: string): string {
  const words = quote
    .split(/[^\p{L}\p{N}'.-]+/u)
    .map((word) => normName(word))
    .filter((word) => word !== '')
  return ` ${words.join(' ')} `
}

/** Re-points the evidence of `mergeId` to `keepId` (the caller holds the transaction). */
export function mergeEvidence(db: TreeDb, keepId: string, mergeId: string): void {
  db.update(claim).set({ recordId: keepId }).where(eq(claim.recordId, mergeId)).run()
  db.update(claim).set({ objectId: keepId }).where(eq(claim.objectId, mergeId)).run()
  db.update(claim).set({ speakerId: keepId }).where(eq(claim.speakerId, mergeId)).run()
  db.update(claim).set({ fromId: keepId }).where(eq(claim.fromId, mergeId)).run()
  // A claim waiting on its subject among the merged record and others now waits on the kept one
  // (the anchors job attaches it once the scan settles its span).
  for (const row of db
    .select({ id: claim.id, pending: claim.pending })
    .from(claim)
    .where(like(claim.pending, `%${mergeId}%`))
    .all()) {
    const pending = parsePending(row.pending)
    if (pending?.kind !== 'subject' || !pending.candidates.includes(mergeId)) continue
    const candidates = [...new Set(pending.candidates.map((id) => (id === mergeId ? keepId : id)))]
    db.update(claim)
      .set({ pending: JSON.stringify({ kind: 'subject', candidates }) })
      .where(eq(claim.id, row.id))
      .run()
  }

  const cards = db
    .select()
    .from(card)
    .where(or(like(card.present, `%${mergeId}%`), like(card.fields, `%${mergeId}%`)))
    .all()
  for (const row of cards) {
    const stored = parseCard(row.present, row.fields)
    if (stored === null) continue
    const { present, fields } = stored
    const seen = new Set<string>()
    const nextPresent = present.flatMap((entry) => {
      const recordId = entry.recordId === mergeId ? keepId : entry.recordId
      if (seen.has(recordId)) return []
      seen.add(recordId)
      return [{ ...entry, recordId }]
    })
    const pov =
      fields.pov !== null && fields.pov.value === mergeId
        ? { ...fields.pov, value: keepId }
        : fields.pov
    db.update(card)
      .set({ present: JSON.stringify(nextPresent), fields: JSON.stringify({ ...fields, pov }) })
      .where(and(eq(card.nodeId, row.nodeId), eq(card.draftId, row.draftId)))
      .run()
  }

  // P2b: the secrets' and threads' reveals, and the author's knew-before marks (both ends).
  db.update(topicQuote).set({ recordId: keepId }).where(eq(topicQuote.recordId, mergeId)).run()
  for (const column of ['secretId', 'recordId'] as const) {
    for (const row of db.select().from(knewBefore).where(eq(knewBefore[column], mergeId)).all()) {
      const moved =
        column === 'secretId' ? { ...row, secretId: keepId } : { ...row, recordId: keepId }
      const where = and(
        eq(knewBefore.secretId, row.secretId),
        eq(knewBefore.recordId, row.recordId)
      )
      const taken =
        moved.secretId === moved.recordId ||
        db
          .select({ created: knewBefore.created })
          .from(knewBefore)
          .where(
            and(eq(knewBefore.secretId, moved.secretId), eq(knewBefore.recordId, moved.recordId))
          )
          .get() !== undefined
      if (taken) db.delete(knewBefore).where(where).run()
      else db.update(knewBefore).set(moved).where(where).run()
    }
  }

  const kept = new Set(
    db
      .select({ norm: memoryBackfill.norm })
      .from(memoryBackfill)
      .where(eq(memoryBackfill.recordId, keepId))
      .all()
      .map((row) => row.norm)
  )
  for (const row of db
    .select()
    .from(memoryBackfill)
    .where(eq(memoryBackfill.recordId, mergeId))
    .all()) {
    const where = and(eq(memoryBackfill.recordId, mergeId), eq(memoryBackfill.norm, row.norm))
    if (kept.has(row.norm)) db.delete(memoryBackfill).where(where).run()
    else db.update(memoryBackfill).set({ recordId: keepId }).where(where).run()
  }
}

/**
 * Moves to `intoId` the claims of `fromId` whose subject was pinned by one of the moved names
 * (`movedNorms`, `normName` forms), and the card entries (on the page, POV) whose quote names the
 * record by a moved name and by none of the names it keeps (`keptNorms`); answers how many claims
 * moved. Pronoun claims stay.
 */
export function splitEvidence(
  db: TreeDb,
  fromId: string,
  intoId: string,
  movedNorms: readonly string[],
  keptNorms: readonly string[]
): number {
  const norms = new Set(movedNorms)
  /** Whether a card quote names the record only by a moved name. */
  const movedBy = (quote: string): boolean => {
    const words = quoteWords(quote)
    return (
      movedNorms.some((norm) => words.includes(` ${norm} `)) &&
      !keptNorms.some((norm) => words.includes(` ${norm} `))
    )
  }
  const cards = db
    .select()
    .from(card)
    .where(or(like(card.present, `%${fromId}%`), like(card.fields, `%${fromId}%`)))
    .all()
  for (const row of cards) {
    const stored = parseCard(row.present, row.fields)
    if (stored === null) continue
    const { present, fields } = stored
    const nextPresent = present.map((entry) =>
      entry.recordId === fromId && movedBy(entry.quote) ? { ...entry, recordId: intoId } : entry
    )
    const pov =
      fields.pov !== null && fields.pov.value === fromId && movedBy(fields.pov.quote)
        ? { ...fields.pov, value: intoId }
        : fields.pov
    db.update(card)
      .set({ present: JSON.stringify(nextPresent), fields: JSON.stringify({ ...fields, pov }) })
      .where(and(eq(card.nodeId, row.nodeId), eq(card.draftId, row.draftId)))
      .run()
  }
  const ids = db
    .select({ id: claim.id, subjectText: claim.subjectText })
    .from(claim)
    .where(eq(claim.recordId, fromId))
    .all()
    .filter((row) => row.subjectText !== null && norms.has(normName(row.subjectText)))
    .map((row) => row.id)
  if (ids.length > 0) db.update(claim).set({ recordId: intoId }).where(inArray(claim.id, ids)).run()
  return ids.length
}

/**
 * The knows claims about a secret that is going (P2b): their object would be cleared, leaving
 * orphan lines nobody can read. Answers how many went. The caller holds the transaction.
 */
export function deleteKnowsAbout(db: TreeDb, secretId: string): number {
  return db
    .delete(claim)
    .where(and(eq(claim.objectId, secretId), eq(claim.slot, 'knows')))
    .run().changes
}

const PageDoc = TiptapNode

/** Whether a stored page (Tiptap JSON) holds any text. */
function hasText(raw: string | null): boolean {
  if (raw === null) return false
  try {
    const parsed = PageDoc.safeParse(JSON.parse(raw))
    return parsed.success && docToText(parsed.data).trim() !== ''
  } catch {
    return false
  }
}

/** What backs one secret or thread: its reveals and claims in any draft, and the author's touch. */
export interface TopicBacking {
  recordId: string
  origin: string
  quotes: number
  claims: number
  /** Pinned or Ideas text, or a knew-before mark. */
  authorTouched: boolean
}

/** Every secret's and thread's backing (the invariants' `topicEmpty` and `emptyTopics` read it). */
export function topicBackings(db: TreeDb): TopicBacking[] {
  const topics = db
    .select({
      id: record.id,
      categoryId: record.categoryId,
      origin: record.origin,
      pinned: record.pinned,
      ideas: record.ideas
    })
    .from(record)
    .all()
    .filter((row) => isTopicCategory(row.categoryId))
  if (topics.length === 0) return []
  const ids = topics.map((row) => row.id)
  const count = (rows: { id: string | null; n: number }[]): Map<string, number> =>
    new Map(rows.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])))
  const quotes = count(
    db
      .select({ id: topicQuote.recordId, n: sql<number>`count(*)` })
      .from(topicQuote)
      .where(inArray(topicQuote.recordId, ids))
      .groupBy(topicQuote.recordId)
      .all()
  )
  const asObject = count(
    db
      .select({ id: claim.objectId, n: sql<number>`count(*)` })
      .from(claim)
      .where(and(inArray(claim.objectId, ids), eq(claim.slot, 'knows')))
      .groupBy(claim.objectId)
      .all()
  )
  const asRecord = count(
    db
      .select({ id: claim.recordId, n: sql<number>`count(*)` })
      .from(claim)
      .where(inArray(claim.recordId, ids))
      .groupBy(claim.recordId)
      .all()
  )
  const marked = new Set(
    db
      .select({ id: knewBefore.secretId })
      .from(knewBefore)
      .where(inArray(knewBefore.secretId, ids))
      .all()
      .map((row) => row.id)
  )
  return topics.map((row) => ({
    recordId: row.id,
    origin: row.origin,
    quotes: quotes.get(row.id) ?? 0,
    claims: (asObject.get(row.id) ?? 0) + (asRecord.get(row.id) ?? 0),
    authorTouched: marked.has(row.id) || hasText(row.pinned) || hasText(row.ideas)
  }))
}

/**
 * The AI-made secrets and threads nothing backs any more (P2b-D12): no reveal and no claim left
 * in any draft, and nothing from the author (no Pinned or Ideas text, no knew-before). The record
 * store deletes them (`pruneTopics`).
 */
export function emptyTopics(db: TreeDb): string[] {
  return topicBackings(db)
    .filter(
      (topic) =>
        topic.origin === 'ai' && topic.quotes === 0 && topic.claims === 0 && !topic.authorTouched
    )
    .map((topic) => topic.recordId)
}

/** Whether `recordId` is a secret or a thread (its category says so). */
export function isTopicRecord(db: TreeDb, recordId: string): boolean {
  const row = db
    .select({ categoryId: record.categoryId })
    .from(record)
    .where(eq(record.id, recordId))
    .get()
  return row !== undefined && isTopicCategory(row.categoryId)
}
