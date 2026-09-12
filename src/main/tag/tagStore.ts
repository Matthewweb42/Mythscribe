import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, asc, count, eq, ne, type SQL } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { Tag, TagCreateInput, TagUpdateInput } from '@shared/ipc/contract'
import { DEFAULT_CATEGORY_COLOR, toTagName } from '@shared/tags'
import { tagTemplateById, type TagTemplateId } from '@shared/tagTemplates'
import type * as schema from '../db/schema'
import { documentTag, tag, type TagInsert, type TagRow } from '../db/schema'
import { AppError } from '../ipc/errors'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type TagDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/** The tag columns plus the derived usage count, one row per matching tag, ordered by name. */
function selectWithUsage(db: TagDb, where?: SQL): Tag[] {
  return db
    .select({
      id: tag.id,
      name: tag.name,
      category: tag.category,
      color: tag.color,
      parentId: tag.parentId,
      created: tag.created,
      modified: tag.modified,
      usageCount: count(documentTag.id)
    })
    .from(tag)
    .leftJoin(documentTag, eq(documentTag.tagId, tag.id))
    .where(where)
    .groupBy(tag.id)
    .orderBy(asc(tag.name), asc(tag.id))
    .all()
}

/** Every tag with its usage count (F-4.1), ordered by name. */
export function listTags(db: TagDb): Tag[] {
  return selectWithUsage(db)
}

/** One tag with its usage count, or undefined when the id is unknown. */
export function getTagWithUsage(db: TagDb, id: string): Tag | undefined {
  return selectWithUsage(db, eq(tag.id, id))[0]
}

export function getTag(db: TagDb, id: string): TagRow | undefined {
  return db.select().from(tag).where(eq(tag.id, id)).get()
}

/** Kebab-cases the name and refuses one that has nothing left. */
function normalizeName(input: string): string {
  const name = toTagName(input)
  if (name.length === 0) {
    throw new AppError('VALIDATION', 'A tag name needs at least one letter or digit', { input })
  }
  return name
}

/** The id of the tag (other than `exceptId`) that carries `name`, or undefined when it is free. */
function findByName(db: TagDb, name: string, exceptId?: string): string | undefined {
  return db
    .select({ id: tag.id })
    .from(tag)
    .where(
      exceptId === undefined ? eq(tag.name, name) : and(eq(tag.name, name), ne(tag.id, exceptId))
    )
    .get()?.id
}

/** Refuses a name another tag (than `exceptId`) already carries. */
function assertNameFree(db: TagDb, name: string, exceptId?: string): void {
  const clash = findByName(db, name, exceptId)
  if (clash !== undefined) {
    throw new AppError('ALREADY_EXISTS', `A tag named "${name}" already exists`, {
      name,
      id: clash
    })
  }
}

/** The parent must exist; `parentId` null clears the parent. */
function assertParentExists(db: TagDb, parentId: string): TagRow {
  const parent = getTag(db, parentId)
  if (!parent) throw new AppError('NOT_FOUND', 'Parent tag not found', { id: parentId })
  return parent
}

/**
 * Refuses a parent that is the tag itself or one of its descendants: walks `parentId` up from
 * the proposed parent and fails if the walk reaches `id`.
 */
function assertNoCycle(db: TagDb, id: string, parent: TagRow): void {
  for (let current: TagRow | undefined = parent; current;) {
    if (current.id === id) {
      throw new AppError('VALIDATION', 'A tag cannot be nested under itself or its own child', {
        id,
        parentId: parent.id
      })
    }
    current = current.parentId === null ? undefined : getTag(db, current.parentId)
  }
}

/**
 * Creates a tag (F-4.1): the name is kebab-cased and must be unique after normalization, the
 * color defaults to the category's, and the parent (when given) must exist. Returns the tag
 * with `usageCount: 0`.
 */
export function createTag(db: TagDb, input: TagCreateInput): Tag {
  return db.transaction((tx) => {
    const name = normalizeName(input.name)
    assertNameFree(tx, name)
    const parentId = input.parentId ?? null
    if (parentId !== null) assertParentExists(tx, parentId)
    return insertTag(tx, { ...input, name, parentId })
  })
}

/** The one insert: a validated, normalized name and a checked parent go in; the row comes back. */
function insertTag(
  db: TagDb,
  input: { name: string; category: Tag['category']; color?: string; parentId: string | null }
): Tag {
  const now = new Date().toISOString()
  const row: TagInsert = {
    id: randomUUID(),
    name: input.name,
    category: input.category,
    color: input.color ?? DEFAULT_CATEGORY_COLOR[input.category],
    parentId: input.parentId,
    created: now,
    modified: now
  }
  const inserted = db.insert(tag).values(row).returning().get()
  return { ...inserted, usageCount: 0 }
}

/**
 * Loads a tag template (F-4.3) in one transaction: every template tag whose name is not yet in
 * the bank is created top-level with the category's default color; a name already taken (by any
 * tag, whatever its category) is skipped. `created` holds the new rows and `skipped` the taken
 * names, both in template order.
 */
export function loadTagTemplate(
  db: TagDb,
  templateId: TagTemplateId
): { created: Tag[]; skipped: string[] } {
  const template = tagTemplateById(templateId)
  if (!template) throw new AppError('NOT_FOUND', 'Tag template not found', { id: templateId })
  return db.transaction((tx) => {
    const created: Tag[] = []
    const skipped: string[] = []
    for (const entry of template.tags) {
      const name = normalizeName(entry.name)
      if (findByName(tx, name) !== undefined) skipped.push(entry.name)
      else created.push(insertTag(tx, { name, category: entry.category, parentId: null }))
    }
    return { created, skipped }
  })
}

/**
 * Patches the given fields of a tag (F-4.1); omitted fields keep their value. The same name and
 * parent rules as `createTag` apply, and a parent that is the tag itself or one of its
 * descendants is refused with VALIDATION. Stamps `modified`.
 */
export function updateTag(db: TagDb, id: string, patch: Omit<TagUpdateInput, 'id'>): Tag {
  return db.transaction((tx) => {
    const existing = getTag(tx, id)
    if (!existing) throw new AppError('NOT_FOUND', 'Tag not found', { id })
    const changes: Partial<TagInsert> = {}
    if (patch.name !== undefined) {
      const name = normalizeName(patch.name)
      if (name !== existing.name) assertNameFree(tx, name, id)
      changes.name = name
    }
    if (patch.category !== undefined) changes.category = patch.category
    if (patch.color !== undefined) changes.color = patch.color
    if (patch.parentId !== undefined) {
      if (patch.parentId !== null) assertNoCycle(tx, id, assertParentExists(tx, patch.parentId))
      changes.parentId = patch.parentId
    }
    tx.update(tag)
      .set({ ...changes, modified: new Date().toISOString() })
      .where(eq(tag.id, id))
      .run()
    const updated = getTagWithUsage(tx, id)
    if (!updated) throw new AppError('NOT_FOUND', 'Tag not found', { id })
    return updated
  })
}

/**
 * Deletes a tag (F-4.1). Its `document_tag` links go through the schema's `ON DELETE CASCADE`
 * and its child tags become top-level through `ON DELETE SET NULL` (`foreign_keys` is on for
 * every connection).
 */
export function deleteTag(db: TagDb, id: string): void {
  const existing = getTag(db, id)
  if (!existing) throw new AppError('NOT_FOUND', 'Tag not found', { id })
  db.delete(tag).where(eq(tag.id, id)).run()
}
