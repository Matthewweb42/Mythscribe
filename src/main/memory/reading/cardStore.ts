import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { CardFields, CardPresent, emptyCardFields, type Card } from '@shared/memory/claims'
import { sha256 } from '../../ai/request'
import { card, type CardRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { indexOwner } from '../passageIndexer'

/**
 * Cards of story memory v2 (F-16.18): the one writer of `card`, one per scene and draft, the AI's
 * map of the scene (findable, never citable). The active draft's card line and gist go into the
 * passage index as source `card` (`indexOwner(db, 'card', nodeId)`), labelled `notCanon`, while
 * the node is a manuscript scene; a card kept for a node moved out of the manuscript (Research,
 * front or end matter) is stored but not indexed, and the passage job settles it if it comes back.
 */

/** Indexes the active draft's card of `nodeId`, when the node is still a manuscript scene. */
function indexCard(db: TreeDb, nodeId: string, now: Date): void {
  try {
    indexOwner(db, 'card', nodeId, now)
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'NOT_FOUND')) throw err
  }
}

const Hashes = z.array(z.string())
const Present = z.array(CardPresent)

function parse<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function toCard(row: CardRow): Card {
  return {
    nodeId: row.nodeId,
    draftId: row.draftId,
    readingId: row.readingId,
    line: row.line,
    gist: row.gist,
    fields: parse(row.fields, CardFields, emptyCardFields()),
    present: parse(row.present, Present, []),
    mood: row.mood,
    theme: row.theme,
    anchor: parse(row.anchor, Hashes, []),
    seen: parse(row.seen, Hashes, []),
    lineHash: row.lineHash,
    created: row.created
  }
}

export function getCard(db: TreeDb, nodeId: string, draftId: string): Card | null {
  const row = db
    .select()
    .from(card)
    .where(and(eq(card.nodeId, nodeId), eq(card.draftId, draftId)))
    .get()
  return row === undefined ? null : toCard(row)
}

/** Every card of one draft (the typed-detail conflicts read them all). */
export function draftCards(db: TreeDb, draftId: string): Card[] {
  return db.select().from(card).where(eq(card.draftId, draftId)).all().map(toCard)
}

/** The raw row (Rename in book's undo keeps it). */
export function getCardRow(db: TreeDb, nodeId: string, draftId: string): CardRow | null {
  return (
    db
      .select()
      .from(card)
      .where(and(eq(card.nodeId, nodeId), eq(card.draftId, draftId)))
      .get() ?? null
  )
}

export type NewCard = Omit<Card, 'lineHash' | 'created'>

/**
 * Writes a scene's card in a draft (replacing the one there), then, for the active draft,
 * indexes its line and gist. The line's hash moves only when the line does (plan links read it).
 */
export function upsertCard(db: TreeDb, next: NewCard, now: Date): void {
  const row: CardRow = {
    nodeId: next.nodeId,
    draftId: next.draftId,
    readingId: next.readingId,
    line: next.line,
    gist: next.gist,
    fields: JSON.stringify(next.fields),
    present: JSON.stringify(next.present),
    mood: next.mood,
    theme: next.theme,
    anchor: JSON.stringify(next.anchor),
    seen: JSON.stringify(next.seen),
    lineHash: sha256(next.line),
    created: now.toISOString()
  }
  db.transaction((tx) => {
    tx.insert(card)
      .values(row)
      .onConflictDoUpdate({ target: [card.nodeId, card.draftId], set: row })
      .run()
    if (currentDraftId(tx) === next.draftId) indexCard(tx, next.nodeId, now)
  })
}

/** Puts a card row back as it was, or writes a rewritten one (Rename in book), and re-indexes it. */
export function writeCardRow(db: TreeDb, row: CardRow, now: Date): void {
  db.insert(card)
    .values(row)
    .onConflictDoUpdate({ target: [card.nodeId, card.draftId], set: row })
    .run()
  if (currentDraftId(db) === row.draftId) indexCard(db, row.nodeId, now)
}

/**
 * A card's fields and on-page entries with their paragraphs moved (`cardParas`: paragraphs came or
 * went above their quotes). Nothing indexed changes: the line and gist stay.
 */
export function moveCardParas(
  db: TreeDb,
  nodeId: string,
  draftId: string,
  next: { fields: CardFields; present: readonly CardPresent[] }
): void {
  db.update(card)
    .set({ fields: JSON.stringify(next.fields), present: JSON.stringify(next.present) })
    .where(and(eq(card.nodeId, nodeId), eq(card.draftId, draftId)))
    .run()
}
