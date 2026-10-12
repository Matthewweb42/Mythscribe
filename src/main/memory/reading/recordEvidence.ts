import { and, eq, inArray, like, or } from 'drizzle-orm'
import { z } from 'zod'
import { CardFields, CardPresent } from '@shared/memory/claims'
import { normName } from '@shared/memory/names'
import { card, claim, memoryBackfill } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The reading's evidence when records merge or split (F-16.4's *Same as…* and *Split*, F-16.17;
 * plan P2a §1.4), inside the record store's transaction:
 * - a merge re-points every claim (subject, object, speaker, source), each card's on-page records
 *   and verified POV, and the back-fill rows from the merged record to the kept one;
 * - a split moves the claims whose subject was pinned by a moved name (`subject_text`); claims
 *   with a pronoun subject stay with the record.
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

/** Re-points the evidence of `mergeId` to `keepId` (the caller holds the transaction). */
export function mergeEvidence(db: TreeDb, keepId: string, mergeId: string): void {
  db.update(claim).set({ recordId: keepId }).where(eq(claim.recordId, mergeId)).run()
  db.update(claim).set({ objectId: keepId }).where(eq(claim.objectId, mergeId)).run()
  db.update(claim).set({ speakerId: keepId }).where(eq(claim.speakerId, mergeId)).run()
  db.update(claim).set({ fromId: keepId }).where(eq(claim.fromId, mergeId)).run()

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
 * (`movedNorms`, `normName` forms); answers how many moved. Pronoun claims stay.
 */
export function splitEvidence(
  db: TreeDb,
  fromId: string,
  intoId: string,
  movedNorms: readonly string[]
): number {
  const norms = new Set(movedNorms)
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
