import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, eq, ne } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  ENTITY_KIND_NOUN,
  ENTITY_KINDS,
  ENTITY_TAG_CATEGORY,
  entityTagName,
  fieldIdsFor,
  isFieldOf,
  kindHasImage,
  parseEntityFields,
  toEntityNameKey,
  type EntityFields,
  type EntityKind
} from '@shared/entities'
import type { Entity, EntityCreateInput, EntityUpdateInput, Tag } from '@shared/ipc/contract'
import type * as schema from '../db/schema'
import { entity, type EntityInsert, type EntityRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createTag, findTagByName, getTag, getTagWithUsage, updateTag } from '../tag/tagStore'

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
 * What an entity write did to the bank (F-9.4): the tag the entity now carries, and whether that
 * tag was created for it (the manuscript is worth rescanning for the new name) or renamed with it
 * (the same). A tag that was only linked is neither, and the windows still hear about it.
 */
export interface EntityTagChange {
  tag: Tag
  created: boolean
  renamed: boolean
}

/** An entity write and what it did to the tag bank (F-9.4); `tagChange` is null when nothing did. */
export interface EntityWrite {
  entity: Entity
  tagChange: EntityTagChange | null
}

/** An entity write that always touched the bank (F-9.4): what `linkEntityTag` answers. */
export interface EntityTagWrite extends EntityWrite {
  tagChange: EntityTagChange
}

/** The tag of the bank with this id, or NOT_FOUND: the row was read a statement ago. */
function requireTagWithUsage(db: EntityDb, id: string): Tag {
  const found = getTagWithUsage(db, id)
  if (found === undefined) throw new AppError('NOT_FOUND', 'Tag not found', { id })
  return found
}

function setTagId(db: EntityDb, id: string, tagId: string): void {
  db.update(entity).set({ tagId }).where(eq(entity.id, id)).run()
}

/**
 * Gives the row the tag of its name (F-9.4): the tag of the bank that already carries
 * `entityTagName(name)`, whatever that tag's category — the author may have written `#mara` long
 * before the character sheet — or a new one under the kind's category. Answers null, and writes
 * nothing, for a name no tag name can be made of ("???"): an entity is never refused over its tag.
 * Linking the tag the row already carries is a no-op that answers the pair all the same.
 */
function linkTag(db: EntityDb, row: EntityRow): EntityTagChange | null {
  const name = entityTagName(row.name)
  if (name === '') return null
  const existing = findTagByName(db, name)
  if (existing !== undefined) {
    if (row.tagId !== existing) setTagId(db, row.id, existing)
    return { tag: requireTagWithUsage(db, existing), created: false, renamed: false }
  }
  const created = createTag(db, { name, category: ENTITY_TAG_CATEGORY[row.kind] })
  setTagId(db, row.id, created.id)
  return { tag: created, created: true, renamed: false }
}

/** Whether another entity carries the same tag: then a rename must leave that tag alone. */
function tagIsShared(db: EntityDb, id: string, tagId: string): boolean {
  return (
    db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.tagId, tagId), ne(entity.id, id)))
      .get() !== undefined
  )
}

/**
 * Carries a renamed entity's tag with it (F-9.4), but only while that tag still mirrors the
 * entity: it carries the old name kebab-cased and no second entity shares it. A tag the author
 * renamed by hand, or one two entities point at, keeps its name and its link. A new name that is
 * already a tag of the bank relinks the entity to it and leaves the old tag where it is; a name
 * with no tag name in it ("???") changes nothing.
 */
function mirrorRename(db: EntityDb, before: EntityRow, after: EntityRow): EntityTagChange | null {
  const tagId = before.tagId
  if (tagId === null) return null
  const tag = getTag(db, tagId)
  if (tag?.name !== entityTagName(before.name)) return null
  if (tagIsShared(db, before.id, tagId)) return null
  const name = entityTagName(after.name)
  if (name === '' || name === tag.name) return null
  const taken = findTagByName(db, name)
  if (taken !== undefined) {
    setTagId(db, after.id, taken)
    return { tag: requireTagWithUsage(db, taken), created: false, renamed: false }
  }
  return { tag: updateTag(db, tagId, { name }), created: false, renamed: true }
}

/**
 * Creates an entity (F-9.1): the name is trimmed and must be free among the entities of its
 * kind, the fields must belong to that kind's template, and the template defaults to
 * `structured`. `image` starts null (F-9.3 writes it).
 *
 * F-9.4: the same transaction creates or links the entity's tag, so an entity and its tag arrive
 * together or not at all. `tagChange` says what the bank owes the windows.
 */
export function createEntity(db: EntityDb, input: EntityCreateInput): EntityWrite {
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
    const inserted = tx.insert(entity).values(row).returning().get()
    const tagChange = linkTag(tx, inserted)
    return {
      entity: rowToEntity(tagChange === null ? inserted : { ...inserted, tagId: tagChange.tag.id }),
      tagChange
    }
  })
}

/**
 * Patches the given parts of an entity (F-9.1); omitted ones keep their value. `fields` is
 * merged over the stored map and an empty value removes that field. The kind cannot change, so
 * the name and the fields are checked against the stored one. Stamps `modified`.
 *
 * F-9.4: a rename carries the entity's tag with it under `mirrorRename`'s rules; every other
 * patch leaves the bank alone.
 */
export function updateEntity(
  db: EntityDb,
  id: string,
  patch: Omit<EntityUpdateInput, 'id'>
): EntityWrite {
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
    const tagChange = changes.name === undefined ? null : mirrorRename(tx, existing, updated)
    return {
      entity: rowToEntity(tagChange === null ? updated : { ...updated, tagId: tagChange.tag.id }),
      tagChange
    }
  })
}

/**
 * Creates or links the tag of the entity's current name (F-9.4): the entity page's "Create tag",
 * and how an entity written before F-9.4, or one whose tag was deleted, gets one. Idempotent —
 * an entity already linked to the tag of its name answers the pair unchanged. NOT_FOUND for an
 * unknown id; VALIDATION for a name no tag name can be made of, the one case `createEntity`
 * passes over in silence.
 */
export function linkEntityTag(db: EntityDb, id: string): EntityTagWrite {
  return db.transaction((tx) => {
    const row = getRow(tx, id)
    if (!row) throw new AppError('NOT_FOUND', 'Entity not found', { id })
    const tagChange = linkTag(tx, row)
    if (tagChange === null) {
      throw new AppError(
        'VALIDATION',
        `"${row.name}" has no letters or digits to make a tag from`,
        {
          id,
          name: row.name
        }
      )
    }
    return { entity: rowToEntity({ ...row, tagId: tagChange.tag.id }), tagChange }
  })
}

/**
 * Sets or clears the entity's image (F-9.3): `image` is the file name stored in the project's
 * `assets/entities/`, or null for none. The file itself is the handler's business — this only
 * writes the column and stamps `modified`. A kind that carries no image (a world item) is
 * VALIDATION, an unknown id NOT_FOUND.
 */
export function setEntityImage(db: EntityDb, id: string, image: string | null): Entity {
  return db.transaction((tx) => {
    const existing = getRow(tx, id)
    if (!existing) throw new AppError('NOT_FOUND', 'Entity not found', { id })
    if (!kindHasImage(existing.kind)) {
      throw new AppError('VALIDATION', `A ${ENTITY_KIND_NOUN[existing.kind]} has no image`, {
        id,
        kind: existing.kind
      })
    }
    const updated = tx
      .update(entity)
      .set({ image, modified: new Date().toISOString() })
      .where(eq(entity.id, id))
      .returning()
      .get()
    return rowToEntity(updated)
  })
}

/**
 * Deletes an entity (F-9.1) and answers it as it stood, so the caller can take its image file
 * with it (F-9.3). Its tag (F-9.4) is a tag of the bank like any other and stays, with whatever
 * the author has linked it to; only the entity goes.
 */
export function deleteEntity(db: EntityDb, id: string): Entity {
  const row = getRow(db, id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
  db.delete(entity).where(eq(entity.id, id)).run()
  return rowToEntity(row)
}
