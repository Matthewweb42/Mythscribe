import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { findQuote } from '@shared/critique'
import { parseEntityFields, type EntityFields } from '@shared/entities'
import { aiFactKey, authorFactKey, isFieldFact, type Fact, type FactStatus } from '@shared/facts'
import { factKey } from '@shared/observedFacts'
import { relationTypeOf } from '@shared/relations'
import { THREAD_KIND, threadEventOf } from '@shared/threads'
import type * as schema from '../db/schema'
import { entity, fact, node, type FactInsert, type FactRow } from '../db/schema'
import { AppError } from '../ipc/errors'

/**
 * Dated facts (F-9.13): the one store of `fact`, and the one writer of `entity.fields`.
 *
 * - The author's sheet text is the undated baseline. `writeAuthorFields` writes the column and
 *   mirrors every filled field as an undated author fact in the same statement group, so the two
 *   can never disagree; `writeAuthorFact` adds an author line dated at a scene ("From scene…",
 *   decision D4) without touching the column. Nothing else in main writes `entity.fields`.
 * - The AI's facts are written by `applySceneFacts`, one scene at a time, and are sticky
 *   (decision D13): a statement already stored stays, a new one is added, and one goes only when
 *   its quote is no longer in the scene. A hidden fact is a tombstone for its record: the same
 *   statement is never added again from any scene.
 *
 * The AI never writes the author's text (D1, confirmed) and never adds a fact without the words
 * of the scene that state it ("no assuming", confirmed 2026-10-08).
 */

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type FactDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/** One fact of a scene as the reading hands it over, its name already resolved to a record. */
export interface SceneFactInput {
  entityId: string
  attribute: string
  value: string
  quote: string
  /** F-9.14: the other record of a relationship; absent for a field fact or a thread event. */
  objectEntityId?: string
}

/**
 * What tells two statements of one record apart besides the attribute: the value, or for a
 * relationship (F-9.14) the other record, whatever label it carries.
 */
function statementValue(row: { value: string; objectEntityId?: string | null }): string {
  return row.objectEntityId ?? row.value
}

export function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    entityId: row.entityId,
    attribute: row.attribute,
    value: row.value,
    objectEntityId: row.objectEntityId,
    nodeId: row.nodeId,
    quote: row.quote,
    origin: row.origin,
    status: row.status,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/** The undated author row that mirrors one field of `entity.fields`. */
function isBaseline(row: FactRow): boolean {
  return row.origin === 'author' && row.factKey === authorFactKey(row.attribute, null)
}

/** Oldest first, the order every list below answers in. */
const ORDER = [asc(fact.createdAt), asc(fact.id)] as const

/**
 * Every fact of one record the windows show (F-9.13): the AI's (hidden ones included and
 * flagged, so the sheet can offer to restore them) and the author's dated lines, oldest first.
 * The undated baseline rows are the sheet's own text and are not listed. F-9.14: a relationship
 * that names this record as its other end is listed too (its `entityId` is the other record), so
 * the sheet's Relationships block reads both directions from one list.
 */
export function listFactsForEntity(db: FactDb, entityId: string): Fact[] {
  return db
    .select()
    .from(fact)
    .where(or(eq(fact.entityId, entityId), eq(fact.objectEntityId, entityId)))
    .orderBy(...ORDER)
    .all()
    .filter((row) => !isBaseline(row))
    .map(rowToFact)
}

/**
 * The visible dated facts of these records, oldest first: the AI's (with a scene) and the
 * author's dated lines. What the prompt builders and the sheet "at a scene" read beside the
 * author's text (`sheetAt`). A hidden fact is the author's "wrong", so it never reaches a prompt.
 * Field facts only (F-9.14): relationships and thread events are no sheet field, and the prompts
 * that read this list are unchanged by them.
 */
export function factsForEntities(db: FactDb, entityIds: readonly string[]): Fact[] {
  if (entityIds.length === 0) return []
  return db
    .select()
    .from(fact)
    .where(and(inArray(fact.entityId, [...entityIds]), eq(fact.hidden, false)))
    .orderBy(...ORDER)
    .all()
    .filter(
      (row) =>
        !isBaseline(row) && (row.origin === 'author' || row.nodeId !== null) && isFieldFact(row)
    )
    .map(rowToFact)
}

/**
 * The visible AI field facts one scene states, oldest first: what the consistency checker
 * (F-13.4) holds against the rest of the story bible. Relationships and thread events are not
 * listed (F-9.14): a thread advancing in two scenes is no contradiction.
 */
export function factsForNode(db: FactDb, nodeId: string): Fact[] {
  return db
    .select()
    .from(fact)
    .where(and(eq(fact.nodeId, nodeId), eq(fact.origin, 'ai'), eq(fact.hidden, false)))
    .orderBy(...ORDER)
    .all()
    .filter(isFieldFact)
    .map(rowToFact)
}

/**
 * The visible statements of one scene that are no sheet field (F-9.14): its relationships and
 * thread events, AI and author alike, oldest first. The scene card reads its thread events here.
 */
export function eventFactsForNode(db: FactDb, nodeId: string): Fact[] {
  return db
    .select()
    .from(fact)
    .where(and(eq(fact.nodeId, nodeId), eq(fact.hidden, false)))
    .orderBy(...ORDER)
    .all()
    .filter((row) => !isFieldFact(row))
    .map(rowToFact)
}

/** Every fact of these records, hidden ones included, oldest first; the Threads section derives from it. */
export function allFactsForEntities(db: FactDb, entityIds: readonly string[]): Fact[] {
  if (entityIds.length === 0) return []
  return db
    .select()
    .from(fact)
    .where(inArray(fact.entityId, [...entityIds]))
    .orderBy(...ORDER)
    .all()
    .filter((row) => !isBaseline(row))
    .map(rowToFact)
}

/** Whether the manuscript has stated anything about this record, hidden facts included. */
export function hasAiFacts(db: FactDb, entityId: string): boolean {
  return (
    db
      .select({ id: fact.id })
      .from(fact)
      .where(and(eq(fact.entityId, entityId), eq(fact.origin, 'ai')))
      .get() !== undefined
  )
}

/**
 * Mirrors a record's baseline into undated author facts without touching the column: one row
 * per filled field, the value updated where it moved, a row whose field was emptied removed.
 * Answers how many rows moved. `writeAuthorFields` calls it; the open's reconcile calls it alone
 * when an older build edited `entity.fields` directly.
 */
export function syncAuthorBaseline(
  db: FactDb,
  entityId: string,
  fields: EntityFields,
  now: string = new Date().toISOString()
): number {
  const held = new Map(
    db
      .select()
      .from(fact)
      .where(and(eq(fact.entityId, entityId), eq(fact.origin, 'author')))
      .all()
      .filter(isBaseline)
      .map((row) => [row.attribute, row])
  )
  let moved = 0
  for (const [attribute, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue
    const row = held.get(attribute)
    held.delete(attribute)
    if (row === undefined) {
      db.insert(fact)
        .values({
          id: randomUUID(),
          entityId,
          attribute,
          value,
          origin: 'author',
          status: 'canon',
          factKey: authorFactKey(attribute, null),
          createdAt: now,
          updatedAt: now
        })
        .run()
      moved += 1
    } else if (row.value !== value) {
      db.update(fact).set({ value, updatedAt: now }).where(eq(fact.id, row.id)).run()
      moved += 1
    }
  }
  const gone = [...held.values()].map((row) => row.id)
  if (gone.length > 0) {
    db.delete(fact).where(inArray(fact.id, gone)).run()
    moved += gone.length
  }
  return moved
}

/**
 * The one writer of `entity.fields` (F-9.13): stores `fields` as the record's whole baseline (the
 * caller has merged and checked it) and mirrors it as undated author facts. Does not stamp
 * `modified`; the entity store does that with the rest of its write.
 */
export function writeAuthorFields(db: FactDb, entityId: string, fields: EntityFields): void {
  db.update(entity)
    .set({ fields: JSON.stringify(fields) })
    .where(eq(entity.id, entityId))
    .run()
  syncAuthorBaseline(db, entityId, fields)
}

/**
 * One author fact (F-9.13). Undated (`nodeId` null): the field of the baseline is set, or
 * removed for `''`, through `writeAuthorFields`. Dated at a scene (D4, "From scene…"): a line
 * that holds from that scene on is added or replaced, or removed for `''`; the baseline is not
 * touched. NOT_FOUND for an unknown record.
 */
export function writeAuthorFact(
  db: FactDb,
  entityId: string,
  attribute: string,
  value: string,
  nodeId: string | null
): void {
  const row = db.select({ fields: entity.fields }).from(entity).where(eq(entity.id, entityId)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id: entityId })
  if (nodeId === null) {
    const fields: Record<string, string> = {}
    for (const [id, text] of Object.entries(parseEntityFields(row.fields))) {
      if (text !== undefined) fields[id] = text
    }
    if (value === '') delete fields[attribute]
    else fields[attribute] = value
    writeAuthorFields(db, entityId, fields)
    return
  }
  const key = authorFactKey(attribute, nodeId)
  if (value === '') {
    db.delete(fact)
      .where(and(eq(fact.entityId, entityId), eq(fact.factKey, key)))
      .run()
    return
  }
  const now = new Date().toISOString()
  db.insert(fact)
    .values({
      id: randomUUID(),
      entityId,
      attribute,
      value,
      nodeId,
      origin: 'author',
      status: 'canon',
      factKey: key,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [fact.entityId, fact.factKey],
      set: { value, hidden: false, updatedAt: now }
    })
    .run()
}

/** An author's relationship or thread event (F-9.14, `fact:create`). */
export interface AuthorStatementInput {
  entityId: string
  /** `relation:<type>` or `thread:<event>`. */
  attribute: string
  /** The free label of a relationship, or a thread event's note; '' for none. */
  value: string
  /** The other record of a relationship; null for a thread event. */
  objectEntityId: string | null
  /** The scene it holds from; null for "from the start". */
  nodeId: string | null
}

/**
 * Adds the author's own relationship or thread event (F-9.14): a dated (or undated) author fact
 * that is no sheet field, so `entity.fields` is untouched. The same statement at the same scene
 * replaces its label. VALIDATION for an attribute that is neither, a relationship with no other
 * record or with itself, or a thread event on a record outside the thread category; NOT_FOUND for
 * an unknown record or scene.
 */
export function addAuthorStatement(db: FactDb, input: AuthorStatementInput): Fact {
  const relation = relationTypeOf(input.attribute)
  const event = threadEventOf(input.attribute)
  if (relation === null && event === null) {
    throw new AppError('VALIDATION', 'Not a relationship or a thread event', {
      attribute: input.attribute
    })
  }
  const owner = db
    .select({ kind: entity.kind })
    .from(entity)
    .where(eq(entity.id, input.entityId))
    .get()
  if (owner === undefined) {
    throw new AppError('NOT_FOUND', 'Entity not found', { id: input.entityId })
  }
  if (relation !== null) {
    if (input.objectEntityId === null || input.objectEntityId === input.entityId) {
      throw new AppError('VALIDATION', 'A relationship needs another sheet', {
        entityId: input.entityId
      })
    }
    const other = db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.id, input.objectEntityId))
      .get()
    if (other === undefined) {
      throw new AppError('NOT_FOUND', 'Entity not found', { id: input.objectEntityId })
    }
  } else if (owner.kind !== THREAD_KIND || input.objectEntityId !== null) {
    throw new AppError('VALIDATION', 'A thread event belongs on a thread', {
      entityId: input.entityId
    })
  }
  if (input.nodeId !== null) {
    const scene = db.select({ id: node.id }).from(node).where(eq(node.id, input.nodeId)).get()
    if (scene === undefined) {
      throw new AppError('NOT_FOUND', 'Scene not found', { id: input.nodeId })
    }
  }
  const objectEntityId = relation === null ? null : input.objectEntityId
  const key = `${authorFactKey(input.attribute, input.nodeId)}\u0000${statementValue({
    value: relation === null ? input.value : '',
    objectEntityId
  })}`
  const now = new Date().toISOString()
  const stored = db
    .insert(fact)
    .values({
      id: randomUUID(),
      entityId: input.entityId,
      attribute: input.attribute,
      value: input.value,
      objectEntityId,
      nodeId: input.nodeId,
      origin: 'author',
      status: 'canon',
      factKey: key,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [fact.entityId, fact.factKey],
      set: { value: input.value, hidden: false, updatedAt: now }
    })
    .returning()
    .get()
  return rowToFact(stored)
}

/**
 * Deletes one of the author's own relationships or thread events (F-9.14, `fact:delete`) and
 * answers it as it was. VALIDATION for an AI fact (hide it instead: the hide is what stops the
 * next reading from adding it again) and for a sheet field (edited on the sheet); NOT_FOUND for
 * an unknown id.
 */
export function deleteAuthorStatement(db: FactDb, id: string): Fact {
  const row = db.select().from(fact).where(eq(fact.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'Fact not found', { id })
  if (row.origin !== 'author' || isFieldFact(row)) {
    throw new AppError(
      'VALIDATION',
      row.origin === 'ai'
        ? 'The AI read this from a scene: hide it instead, so the next reading does not add it again'
        : 'Edit this on the sheet',
      { id }
    )
  }
  db.delete(fact).where(eq(fact.id, id)).run()
  return rowToFact(row)
}

/** What one scene's reading did to the facts, for the windows and the Changes log. */
export interface SceneFactsDiff {
  /** The facts added, as stored. */
  added: Fact[]
  /** The AI facts that went because their quote left the scene. */
  removed: Fact[]
  /** The records whose visible facts moved, sorted, for `fact:changed`. */
  entityIds: string[]
}

/**
 * What one scene states (F-9.13), sticky (D13), in one transaction: a statement this scene
 * already has stays (its quote refreshed); a new one is added with `status`, unless any hidden
 * fact of the same record says the same (`factKey`, from any scene: the author's "wrong" holds
 * everywhere); a visible AI fact of this scene the reading no longer states goes only when its
 * quote is no longer in `sceneText`, the scene as read. A statement given twice is stored once.
 * Hidden facts are never removed. An empty `rows` with an empty `sceneText` clears the scene's
 * visible AI facts (a scene cut below the summary minimum).
 */
export function applySceneFacts(
  db: FactDb,
  nodeId: string,
  rows: readonly SceneFactInput[],
  sceneText: string,
  status: FactStatus = 'canon'
): SceneFactsDiff {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(fact)
      .where(and(eq(fact.nodeId, nodeId), eq(fact.origin, 'ai')))
      .all()
    const byKey = new Map(existing.map((row) => [`${row.entityId}\u0000${row.factKey}`, row]))
    const entityIds = [...new Set(rows.map((row) => row.entityId))]
    const tombstones = new Set(
      entityIds.length === 0
        ? []
        : tx
            .select()
            .from(fact)
            .where(
              and(inArray(fact.entityId, entityIds), eq(fact.origin, 'ai'), eq(fact.hidden, true))
            )
            .all()
            .map((row) => `${row.entityId}\u0000${factKey(row.attribute, statementValue(row))}`)
    )

    const now = new Date().toISOString()
    const stated = new Set<string>()
    const added: Fact[] = []
    const inserts: FactInsert[] = []
    for (const row of rows) {
      const key = aiFactKey(nodeId, row.attribute, statementValue(row))
      const id = `${row.entityId}\u0000${key}`
      if (stated.has(id)) continue
      stated.add(id)
      const held = byKey.get(id)
      if (held !== undefined) {
        if (held.quote !== row.quote) {
          tx.update(fact)
            .set({ quote: row.quote, updatedAt: now })
            .where(eq(fact.id, held.id))
            .run()
        }
        continue
      }
      if (tombstones.has(`${row.entityId}\u0000${factKey(row.attribute, statementValue(row))}`))
        continue
      const insert: FactInsert = {
        id: randomUUID(),
        entityId: row.entityId,
        attribute: row.attribute,
        value: row.value,
        objectEntityId: row.objectEntityId ?? null,
        nodeId,
        quote: row.quote,
        origin: 'ai',
        status,
        hidden: false,
        factKey: key,
        createdAt: now,
        updatedAt: now
      }
      inserts.push(insert)
    }
    if (inserts.length > 0) {
      for (const inserted of tx.insert(fact).values(inserts).returning().all()) {
        added.push(rowToFact(inserted))
      }
    }

    const removed: Fact[] = []
    for (const row of existing) {
      if (row.hidden || stated.has(`${row.entityId}\u0000${row.factKey}`)) continue
      if (row.quote !== null && findQuote(sceneText, row.quote)) continue
      removed.push(rowToFact(row))
    }
    if (removed.length > 0) {
      tx.delete(fact)
        .where(
          inArray(
            fact.id,
            removed.map((row) => row.id)
          )
        )
        .run()
    }
    // F-9.14: a relationship moves the other record's sheet too.
    const touched = new Set(
      [...added, ...removed].flatMap((row) =>
        row.objectEntityId === null ? [row.entityId] : [row.entityId, row.objectEntityId]
      )
    )
    return { added, removed, entityIds: [...touched].sort() }
  })
}

/**
 * Hides a wrong fact, or restores a hidden one, and answers it as stored. NOT_FOUND for an
 * unknown id: the scene was re-read, or deleted, since the sheet listed it.
 */
export function setFactHidden(db: FactDb, id: string, hidden: boolean): Fact {
  const updated = db
    .update(fact)
    .set({ hidden, updatedAt: new Date().toISOString() })
    .where(eq(fact.id, id))
    .returning()
    .get()
  if (updated === undefined) throw new AppError('NOT_FOUND', 'Fact not found', { id })
  return rowToFact(updated)
}

/** Sets a fact's status (D7: canon, plan, idea) and answers it as stored; NOT_FOUND for an unknown id. */
export function setFactStatus(db: FactDb, id: string, status: FactStatus): Fact {
  const updated = db
    .update(fact)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(fact.id, id))
    .returning()
    .get()
  if (updated === undefined) throw new AppError('NOT_FOUND', 'Fact not found', { id })
  return rowToFact(updated)
}

/**
 * The AI facts of these nodes and every node under them, deleted (F-9.13): a deleted scene takes
 * what it stated with it, in the deleting transaction. An author line dated at one of them stays
 * (its scene column is cleared by the foreign key). Answers the records whose facts went.
 */
export function deleteAiFactsUnder(db: FactDb, nodeIds: readonly string[]): string[] {
  if (nodeIds.length === 0) return []
  const ids = sql.join(
    nodeIds.map((id) => sql`${id}`),
    sql`, `
  )
  const under = sql`WITH RECURSIVE sub(id) AS (
      SELECT id FROM node WHERE id IN (${ids})
      UNION SELECT node.id FROM node JOIN sub ON node.parent_id = sub.id
    ) SELECT id FROM sub`
  const gone = db
    .delete(fact)
    .where(and(eq(fact.origin, 'ai'), sql`${fact.nodeId} IN (${under})`))
    .returning({ entityId: fact.entityId })
    .all()
  return [...new Set(gone.map((row) => row.entityId))].sort()
}

/**
 * Moves the dated facts of merged-away records onto the target (F-9.10's merge): a statement the
 * target already holds under the same key stays the target's and the source's copy goes. The
 * sources' baseline rows are left for their cascade; the merge rewrites the target's baseline.
 */
export function moveFacts(db: FactDb, sourceIds: readonly string[], targetId: string): void {
  if (sourceIds.length === 0) return
  const taken = new Set(
    db
      .select({ key: fact.factKey })
      .from(fact)
      .where(eq(fact.entityId, targetId))
      .all()
      .map((row) => row.key)
  )
  const rows = db
    .select()
    .from(fact)
    .where(inArray(fact.entityId, [...sourceIds]))
    .orderBy(...ORDER)
    .all()
  for (const row of rows) {
    if (isBaseline(row)) continue
    if (taken.has(row.factKey)) {
      db.delete(fact).where(eq(fact.id, row.id)).run()
      continue
    }
    taken.add(row.factKey)
    db.update(fact).set({ entityId: targetId }).where(eq(fact.id, row.id)).run()
  }
}
