import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, eq, ne } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  ENTITY_KINDS,
  fieldIdsFor,
  isFieldOf,
  parseEntityFields,
  toEntityNameKey,
  type EntityFields,
  type EntityKind
} from '@shared/entities'
import type { Entity, EntityCreateInput, EntityUpdateInput } from '@shared/ipc/contract'
import type * as schema from '../db/schema'
import { entity, type EntityInsert, type EntityRow } from '../db/schema'
import { AppError } from '../ipc/errors'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type EntityDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/** The stored row as the contract's entity: the only place `fields` is parsed. */
function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    template: row.template,
    fields: parseEntityFields(row.fields, row.kind),
    body: row.body,
    image: row.image,
    tagId: row.tagId,
    created: row.created,
    modified: row.modified
  }
}

function getRow(db: EntityDb, id: string): EntityRow | undefined {
  return db.select().from(entity).where(eq(entity.id, id)).get()
}

/**
 * The story bible's order (F-9.1): characters, then settings, then world, each by name key so
 * "ada" and "Ada" sort together whatever their spelling; the id breaks a true tie. SQLite's
 * `lower()` is ASCII-only and the key collapses whitespace, so the comparison is made here and
 * not in the query.
 */
function compareEntities(a: Entity, b: Entity): number {
  const kind = ENTITY_KINDS.indexOf(a.kind) - ENTITY_KINDS.indexOf(b.kind)
  if (kind !== 0) return kind
  const name = toEntityNameKey(a.name).localeCompare(toEntityNameKey(b.name))
  return name !== 0 ? name : a.id.localeCompare(b.id)
}

/** Every entity of the project (F-9.1), in story-bible order. */
export function listEntities(db: EntityDb): Entity[] {
  return db.select().from(entity).all().map(rowToEntity).sort(compareEntities)
}

/** One entity, or undefined when the id is unknown (the handler answers NOT_FOUND). */
export function getEntity(db: EntityDb, id: string): Entity | undefined {
  const row = getRow(db, id)
  return row === undefined ? undefined : rowToEntity(row)
}

/** Trims the name and refuses one that has nothing left. */
function normalizeName(input: string): string {
  const name = input.trim()
  if (name.length === 0) {
    throw new AppError('VALIDATION', 'An entity needs a name', { input })
  }
  return name
}

/**
 * The id of the entity of this kind (other than `exceptId`) whose name key is `key`, or
 * undefined when the name is free. Compared in memory for the reason `compareEntities` gives.
 */
function findByNameKey(
  db: EntityDb,
  kind: EntityKind,
  key: string,
  exceptId?: string
): string | undefined {
  return db
    .select({ id: entity.id, name: entity.name })
    .from(entity)
    .where(
      exceptId === undefined
        ? eq(entity.kind, kind)
        : and(eq(entity.kind, kind), ne(entity.id, exceptId))
    )
    .all()
    .find((row) => toEntityNameKey(row.name) === key)?.id
}

/** Refuses a name another entity of the same kind already carries; kinds do not collide. */
function assertNameFree(db: EntityDb, kind: EntityKind, name: string, exceptId?: string): void {
  const clash = findByNameKey(db, kind, toEntityNameKey(name), exceptId)
  if (clash !== undefined) {
    throw new AppError('ALREADY_EXISTS', `A ${kind} named "${name}" already exists`, {
      kind,
      name,
      id: clash
    })
  }
}

/** Refuses a field that is not of this kind's template ("age" on a setting). */
function assertFieldsOf(kind: EntityKind, fields: EntityFields): void {
  for (const id of Object.keys(fields)) {
    if (!isFieldOf(kind, id)) {
      throw new AppError('VALIDATION', `"${id}" is not a field of a ${kind}`, { kind, field: id })
    }
  }
}

/** The given values of the kind's template, empty ones left out: what the column stores. */
function collectFields(kind: EntityKind, base: EntityFields, patch: EntityFields): EntityFields {
  const merged: EntityFields = { ...base }
  for (const id of fieldIdsFor(kind)) {
    const value = patch[id]
    if (value === undefined) continue
    // An empty value is how a patch removes a field, and is never stored.
    if (value === '') delete merged[id]
    else merged[id] = value
  }
  return merged
}

/**
 * Creates an entity (F-9.1): the name is trimmed and must be free among the entities of its
 * kind, the fields must belong to that kind's template, and the template defaults to
 * `structured`. `image` and `tag_id` start null; F-9.3 and F-9.4 write them.
 */
export function createEntity(db: EntityDb, input: EntityCreateInput): Entity {
  return db.transaction((tx) => {
    const name = normalizeName(input.name)
    assertNameFree(tx, input.kind, name)
    const fields = input.fields ?? {}
    assertFieldsOf(input.kind, fields)
    const now = new Date().toISOString()
    const row: EntityInsert = {
      id: randomUUID(),
      kind: input.kind,
      name,
      template: input.template ?? 'structured',
      fields: JSON.stringify(collectFields(input.kind, {}, fields)),
      body: input.body ?? null,
      image: null,
      tagId: null,
      created: now,
      modified: now
    }
    return rowToEntity(tx.insert(entity).values(row).returning().get())
  })
}

/**
 * Patches the given parts of an entity (F-9.1); omitted ones keep their value. `fields` is
 * merged over the stored map and an empty value removes that field. The kind cannot change, so
 * the name and the fields are checked against the stored one. Stamps `modified`.
 */
export function updateEntity(
  db: EntityDb,
  id: string,
  patch: Omit<EntityUpdateInput, 'id'>
): Entity {
  return db.transaction((tx) => {
    const existing = getRow(tx, id)
    if (!existing) throw new AppError('NOT_FOUND', 'Entity not found', { id })
    const changes: Partial<EntityInsert> = {}
    if (patch.name !== undefined) {
      const name = normalizeName(patch.name)
      if (toEntityNameKey(name) !== toEntityNameKey(existing.name)) {
        assertNameFree(tx, existing.kind, name, id)
      }
      changes.name = name
    }
    if (patch.template !== undefined) changes.template = patch.template
    if (patch.fields !== undefined) {
      assertFieldsOf(existing.kind, patch.fields)
      const merged = collectFields(
        existing.kind,
        parseEntityFields(existing.fields, existing.kind),
        patch.fields
      )
      changes.fields = JSON.stringify(merged)
    }
    if (patch.body !== undefined) changes.body = patch.body
    const updated = tx
      .update(entity)
      .set({ ...changes, modified: new Date().toISOString() })
      .where(eq(entity.id, id))
      .returning()
      .get()
    return rowToEntity(updated)
  })
}

/**
 * Deletes an entity (F-9.1). Its tag, when F-9.4 has linked one, is a tag of the bank like any
 * other and stays; only the entity goes.
 */
export function deleteEntity(db: EntityDb, id: string): void {
  if (getRow(db, id) === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
  db.delete(entity).where(eq(entity.id, id)).run()
}
