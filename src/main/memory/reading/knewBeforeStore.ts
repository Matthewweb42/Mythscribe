import { and, asc, eq, or, sql } from 'drizzle-orm'
import { KNOWER_KINDS } from '@shared/memory/knows'
import type { KnewBeforeInput } from '@shared/memory/whoKnows'
import { knewBefore, type KnewBeforeRow } from '../../db/schema'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { getRecord, requireRecord } from '../recordStore'

/**
 * *Knew before the book* (F-16.22; design §2.5): the one writer of `knew_before`. Author-owned:
 * the author says a character or group knew a secret before the story starts, from the Book's grid
 * or a secret's sheet (`memory:knewBefore`, a `write` channel, slice 4). The AI never writes here.
 * Both ends cascade with their records; *Same as…* re-points them (`mergeEvidence`).
 */

/**
 * Marks (`knew: true`) or unmarks a knower as knowing a secret before the book. Refused unless the
 * secret is a secret and the knower a character or group. Answers whether anything changed.
 */
export function setKnewBefore(
  db: TreeDb,
  secretId: string,
  recordId: string,
  knew: boolean,
  now: Date
): boolean {
  const secret = requireRecord(db, secretId)
  const knower = requireRecord(db, recordId)
  if (secret.kind !== 'secret') throw new AppError('VALIDATION', 'Only a secret is known before')
  if (!KNOWER_KINDS.includes(knower.kind)) {
    throw new AppError('VALIDATION', 'Only a character or a group knows a secret')
  }
  const where = and(eq(knewBefore.secretId, secretId), eq(knewBefore.recordId, recordId))
  if (!knew) return db.delete(knewBefore).where(where).run().changes > 0
  const result = db
    .insert(knewBefore)
    .values({ secretId, recordId, created: now.toISOString() })
    .onConflictDoNothing()
    .run()
  return result.changes > 0
}

/** Every knew-before mark, oldest first (what `knowsAsOf` reads). */
export function listKnewBefore(db: TreeDb): KnewBeforeInput[] {
  return db
    .select({ secretId: knewBefore.secretId, recordId: knewBefore.recordId })
    .from(knewBefore)
    .orderBy(asc(knewBefore.created), sql`rowid`)
    .all()
}

/** The marks of one secret (or of one knower), as stored (*Not a secret*'s snapshot). */
export function knewBeforeRowsOf(db: TreeDb, recordId: string): KnewBeforeRow[] {
  return db
    .select()
    .from(knewBefore)
    .where(or(eq(knewBefore.secretId, recordId), eq(knewBefore.recordId, recordId)))
    .orderBy(asc(knewBefore.created), sql`rowid`)
    .all()
}

/**
 * Puts marks back as they were stored (*Undo* of *Not a secret*), where both records are still
 * there; one already there stays.
 */
export function insertKnewBeforeRows(db: TreeDb, rows: readonly KnewBeforeRow[]): void {
  for (const row of rows) {
    if (getRecord(db, row.secretId) === null || getRecord(db, row.recordId) === null) continue
    db.insert(knewBefore).values(row).onConflictDoNothing().run()
  }
}
