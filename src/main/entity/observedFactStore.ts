import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { factKey, type ObservedFact } from '@shared/observedFacts'
import type * as schema from '../db/schema'
import { observedFact, type ObservedFactInsert, type ObservedFactRow } from '../db/schema'
import { AppError } from '../ipc/errors'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type ObservedFactDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/** One fact of a scene as the story-bible job hands it over, its name already resolved to an entity. */
export interface SceneFactInput {
  entityId: string
  attribute: string
  value: string
  quote: string
}

function rowToFact(row: ObservedFactRow): ObservedFact {
  return {
    id: row.id,
    entityId: row.entityId,
    nodeId: row.nodeId,
    attribute: row.attribute,
    value: row.value,
    quote: row.quote,
    hidden: row.hidden,
    createdAt: row.createdAt
  }
}

/**
 * Every observed fact of one entity (F-5.16), oldest first, the hidden ones included and
 * flagged: the entity page lists them under "Show hidden". An unknown entity has none.
 */
export function listFactsForEntity(db: ObservedFactDb, entityId: string): ObservedFact[] {
  return db
    .select()
    .from(observedFact)
    .where(eq(observedFact.entityId, entityId))
    .orderBy(asc(observedFact.createdAt), asc(observedFact.id))
    .all()
    .map(rowToFact)
}

/**
 * The visible facts of these entities (F-5.16), oldest first: what the prompt builders read
 * beside the sheets. A hidden fact is the author's "wrong", so it never reaches a prompt.
 */
export function factsForEntities(db: ObservedFactDb, entityIds: readonly string[]): ObservedFact[] {
  if (entityIds.length === 0) return []
  return db
    .select()
    .from(observedFact)
    .where(and(inArray(observedFact.entityId, [...entityIds]), eq(observedFact.hidden, false)))
    .orderBy(asc(observedFact.createdAt), asc(observedFact.id))
    .all()
    .map(rowToFact)
}

/**
 * The visible facts one scene states (F-5.16), oldest first: what the consistency checker
 * (F-13.4) holds against the rest of the story bible.
 */
export function factsForNode(db: ObservedFactDb, nodeId: string): ObservedFact[] {
  return db
    .select()
    .from(observedFact)
    .where(and(eq(observedFact.nodeId, nodeId), eq(observedFact.hidden, false)))
    .orderBy(asc(observedFact.createdAt), asc(observedFact.id))
    .all()
    .map(rowToFact)
}

/** Whether the manuscript has stated anything about this entity, hidden facts included. */
export function hasFacts(db: ObservedFactDb, entityId: string): boolean {
  return (
    db
      .select({ id: observedFact.id })
      .from(observedFact)
      .where(eq(observedFact.entityId, entityId))
      .get() !== undefined
  )
}

/** The key one statement about one entity is held under: the entity and the `factKey`. */
function sceneKey(entityId: string, attribute: string, value: string): string {
  return `${entityId}\u0000${factKey(attribute, value)}`
}

/**
 * Replaces what one scene states (F-5.16), in one transaction: its visible facts go and `rows`
 * come in, so a re-read never piles up. Hidden facts stay as tombstones, and they are the
 * entity's, not the scene's: a row that says what any hidden fact of the same entity says (same
 * `factKey`), whatever scene that one was read from, is not inserted — a fact the author hid as
 * wrong does not come back from this scene or from the next one that repeats it. A statement
 * given twice is stored once. An empty `rows` clears the scene's visible facts. Answers the ids
 * of the entities whose visible facts may have changed (those that lost a fact and those that
 * gained one), for `observedFact:changed`.
 */
export function replaceSceneFacts(
  db: ObservedFactDb,
  nodeId: string,
  rows: readonly SceneFactInput[]
): string[] {
  return db.transaction((tx) => {
    const touched = new Set<string>()
    const visible = tx
      .select({ entityId: observedFact.entityId })
      .from(observedFact)
      .where(and(eq(observedFact.nodeId, nodeId), eq(observedFact.hidden, false)))
      .all()
    for (const row of visible) touched.add(row.entityId)
    tx.delete(observedFact)
      .where(and(eq(observedFact.nodeId, nodeId), eq(observedFact.hidden, false)))
      .run()

    const entityIds = [...new Set(rows.map((row) => row.entityId))]
    const taken = new Set<string>()
    if (entityIds.length > 0) {
      const tombstones = tx
        .select()
        .from(observedFact)
        .where(and(inArray(observedFact.entityId, entityIds), eq(observedFact.hidden, true)))
        .all()
      for (const row of tombstones) taken.add(sceneKey(row.entityId, row.attribute, row.value))
    }

    const createdAt = new Date().toISOString()
    const inserts: ObservedFactInsert[] = []
    for (const row of rows) {
      const key = sceneKey(row.entityId, row.attribute, row.value)
      if (taken.has(key)) continue
      taken.add(key)
      touched.add(row.entityId)
      inserts.push({
        id: randomUUID(),
        entityId: row.entityId,
        nodeId,
        attribute: row.attribute,
        value: row.value,
        quote: row.quote,
        hidden: false,
        createdAt
      })
    }
    if (inserts.length > 0) tx.insert(observedFact).values(inserts).run()
    return [...touched].sort()
  })
}

/**
 * Hides a wrong fact, or restores a hidden one (F-5.16), and answers it as stored. NOT_FOUND for
 * an unknown id: the scene was re-read, or deleted, since the page listed it.
 */
export function setFactHidden(db: ObservedFactDb, id: string, hidden: boolean): ObservedFact {
  const updated = db
    .update(observedFact)
    .set({ hidden })
    .where(eq(observedFact.id, id))
    .returning()
    .get()
  if (updated === undefined) throw new AppError('NOT_FOUND', 'Observed fact not found', { id })
  return rowToFact(updated)
}
