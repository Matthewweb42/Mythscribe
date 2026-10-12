import { and, eq, inArray, like, or } from 'drizzle-orm'
import { z } from 'zod'
import { CardFields, CardPresent, ClaimPending } from '@shared/memory/claims'
import { normName } from '@shared/memory/names'
import { card, claim, memoryBackfill } from '../../db/schema'
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
 * is gone is left out when it is read.
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
