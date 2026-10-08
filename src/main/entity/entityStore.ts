import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { normalizeAliases, parseAliases } from '@shared/aliases'
import {
  categoryFieldIds,
  categoryOf,
  compareCategoryIds,
  isCategoryField,
  joinSheetText,
  refileFields,
  type StoryCategory
} from '@shared/categories'
import {
  entityTagName,
  parseEntityFields,
  toEntityNameKey,
  type EntityFields,
  type EntityKind,
  type EntityOrigin
} from '@shared/entities'
import type { Entity, EntityCreateInput, EntityUpdateInput, Tag } from '@shared/ipc/contract'
import { withObservedDismissed, withoutObservedDismissed } from '@shared/observedFacts'
import type * as schema from '../db/schema'
import { entity, observedFact, tag, type EntityInsert, type EntityRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getObservedDismissed, setObservedDismissed } from '../project/settingsStore'
import {
  addTagAliases,
  createTag,
  findTagByName,
  getTag,
  getTagWithUsage,
  mergeTags,
  updateTag,
  type TagMergeResult
} from '../tag/tagStore'
import { listCategories, requireCategory } from './categoryStore'
import { hasFacts } from './observedFactStore'

/** Accepts both the connection's orm and a transaction handle (both extend this base). */
export type EntityDb = BaseSQLiteDatabase<'sync', RunResult, typeof schema>

/**
 * The stored row as the contract's entity: the only place `fields` is parsed. `tagAliases` is
 * the linked tag's alias list (F-4.14, one owner); a row with no tag answers its own.
 */
function rowToEntity(row: EntityRow, tagAliases: readonly string[] = []): Entity {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    template: row.template,
    fields: parseEntityFields(row.fields),
    body: row.body,
    image: row.image,
    tagId: row.tagId,
    aliases: row.tagId === null ? parseAliases(row.aliases) : [...tagAliases],
    origin: row.origin,
    created: row.created,
    modified: row.modified
  }
}

function getRow(db: EntityDb, id: string): EntityRow | undefined {
  return db.select().from(entity).where(eq(entity.id, id)).get()
}

/** The alias lists of the given tags (F-4.14), by tag id. */
function tagAliasesById(db: EntityDb, tagIds: readonly string[]): Map<string, string[]> {
  if (tagIds.length === 0) return new Map()
  return new Map(
    db
      .select({ id: tag.id, aliases: tag.aliases })
      .from(tag)
      .where(inArray(tag.id, [...new Set(tagIds)]))
      .all()
      .map((row) => [row.id, parseAliases(row.aliases)])
  )
}

/** The row as the contract's entity, its linked tag's aliases read for it (F-4.14). */
function toEntity(db: EntityDb, row: EntityRow): Entity {
  if (row.tagId === null) return rowToEntity(row)
  return rowToEntity(row, tagAliasesById(db, [row.tagId]).get(row.tagId))
}

/**
 * The story bible's order (F-9.1): by category (F-9.11: the library's order, then the project's
 * own categories), each by name key so
 * "ada" and "Ada" sort together whatever their spelling; the id breaks a true tie. SQLite's
 * `lower()` is ASCII-only and the key collapses whitespace, so the comparison is made here and
 * not in the query.
 */
function compareEntities(a: Entity, b: Entity): number {
  const kind = compareCategoryIds(a.kind, b.kind)
  if (kind !== 0) return kind
  const name = toEntityNameKey(a.name).localeCompare(toEntityNameKey(b.name))
  return name !== 0 ? name : a.id.localeCompare(b.id)
}

/** Every entity of the project (F-9.1), in story-bible order. */
export function listEntities(db: EntityDb): Entity[] {
  const rows = db.select().from(entity).all()
  const aliases = tagAliasesById(
    db,
    rows.flatMap((row) => (row.tagId === null ? [] : [row.tagId]))
  )
  return rows
    .map((row) => rowToEntity(row, row.tagId === null ? [] : aliases.get(row.tagId)))
    .sort(compareEntities)
}

/** One entity, or undefined when the id is unknown (the handler answers NOT_FOUND). */
export function getEntity(db: EntityDb, id: string): Entity | undefined {
  const row = getRow(db, id)
  return row === undefined ? undefined : toEntity(db, row)
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

/** Refuses a name another sheet of the same category already carries; categories do not collide. */
function assertNameFree(
  db: EntityDb,
  category: StoryCategory,
  name: string,
  exceptId?: string
): void {
  const clash = findByNameKey(db, category.id, toEntityNameKey(name), exceptId)
  if (clash !== undefined) {
    throw new AppError('ALREADY_EXISTS', `A ${category.noun} named "${name}" already exists`, {
      kind: category.id,
      name,
      id: clash
    })
  }
}

/** Refuses a field that is not of the category's template ("age" on a place). */
function assertFieldsOf(category: StoryCategory, fields: EntityFields): void {
  for (const id of Object.keys(fields)) {
    if (!isCategoryField(category, id)) {
      throw new AppError('VALIDATION', `"${id}" is not a field of a ${category.noun}`, {
        kind: category.id,
        field: id
      })
    }
  }
}

/**
 * The given values of the category's template merged over what is stored, empty ones left out:
 * what the column stores. A stored value outside the template (F-9.11) is kept as it was.
 */
function collectFields(
  category: StoryCategory,
  base: EntityFields,
  patch: EntityFields
): EntityFields {
  const merged: EntityFields = { ...base }
  for (const id of categoryFieldIds(category)) {
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
  /** F-4.14: the tag's aliases changed with the write, which a rescan must hear about too. */
  aliased: boolean
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

/**
 * Links the row to `tagId`. F-4.14, one owner: the aliases the sheet kept while it had no tag
 * move onto the tag (the ones another tag owns are dropped) and the sheet's own list is emptied.
 * Answers whether the tag's aliases changed.
 */
function setTagId(db: EntityDb, row: EntityRow, tagId: string): boolean {
  const own = parseAliases(row.aliases)
  db.update(entity).set({ tagId, aliases: '[]' }).where(eq(entity.id, row.id)).run()
  if (own.length === 0) return false
  const before = getTag(db, tagId)?.aliases
  return addTagAliases(db, tagId, own).aliases.length !== parseAliases(before).length
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
    const aliased = row.tagId !== existing && setTagId(db, row, existing)
    return { tag: requireTagWithUsage(db, existing), created: false, renamed: false, aliased }
  }
  const created = createTag(db, {
    name,
    category: categoryOf(row.kind, listCategories(db)).tagCategory
  })
  setTagId(db, row, created.id)
  return { tag: requireTagWithUsage(db, created.id), created: true, renamed: false, aliased: false }
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
    const aliased = setTagId(db, after, taken)
    return { tag: requireTagWithUsage(db, taken), created: false, renamed: false, aliased }
  }
  return { tag: updateTag(db, tagId, { name }), created: false, renamed: true, aliased: false }
}

/**
 * Creates an entity (F-9.1): the name is trimmed and must be free among the entities of its
 * kind, the fields must belong to that kind's template, and the template defaults to
 * `structured`. `image` starts null (F-9.3 writes it).
 *
 * F-9.4: the same transaction creates or links the entity's tag, so an entity and its tag arrive
 * together or not at all. `tagChange` says what the bank owes the windows.
 *
 * F-5.16: `origin` is `ai` only when the story-bible job creates the entity for a name it met;
 * that caller checks the dismissed names first. An entity the author creates takes its name off
 * that list, so the job may log facts about it again.
 *
 * F-9.8: `tag: false` leaves the new entity untagged — the context library's Project notes page,
 * and a sheet whose tag the author unticked in the review.
 */
export function createEntity(
  db: EntityDb,
  input: EntityCreateInput,
  origin: EntityOrigin = 'author',
  options: { tag?: boolean } = {}
): EntityWrite {
  return db.transaction((tx) => {
    const category = requireCategory(tx, input.kind)
    const name = normalizeName(input.name)
    assertNameFree(tx, category, name)
    const fields = input.fields ?? {}
    assertFieldsOf(category, fields)
    const now = new Date().toISOString()
    const row: EntityInsert = {
      id: randomUUID(),
      kind: input.kind,
      name,
      template: input.template ?? 'structured',
      fields: JSON.stringify(collectFields(category, {}, fields)),
      body: input.body ?? null,
      image: null,
      tagId: null,
      origin,
      created: now,
      modified: now
    }
    const inserted = tx.insert(entity).values(row).returning().get()
    if (origin === 'author') {
      const dismissed = getObservedDismissed(tx)
      const kept = withoutObservedDismissed(dismissed, input.kind, name)
      if (kept !== dismissed) setObservedDismissed(tx, kept)
    }
    const tagChange = options.tag === false ? null : linkTag(tx, inserted)
    return {
      entity: toEntity(tx, requireRow(tx, inserted.id)),
      tagChange
    }
  })
}

/**
 * Patches the given parts of an entity (F-9.1); omitted ones keep their value. `fields` is
 * merged over the stored map and an empty value removes that field. The name and the fields are
 * checked against the sheet's category; F-9.10: `kind` moves the sheet into another category
 * first (`refileFields`), and the name must then be free there. Stamps `modified`.
 *
 * F-9.4: a rename carries the entity's tag with it under `mirrorRename`'s rules; every other
 * patch leaves the bank alone.
 *
 * F-5.16: every caller is the author's hand, so a patch that carries a name, fields, or a body
 * makes an AI-made entity the author's (`origin` → `author`); a template switch alone does not.
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
    let category = categoryOf(existing.kind, listCategories(tx))
    let stored = parseEntityFields(existing.fields)
    // F-9.10: a move into another category refiles the values its template lacks into Notes.
    const moved = patch.kind !== undefined && patch.kind !== existing.kind
    if (moved) {
      const target = requireCategory(tx, patch.kind ?? existing.kind)
      stored = refileFields(category, target, stored)
      changes.kind = target.id
      changes.fields = JSON.stringify(stored)
      category = target
    }
    if (patch.name !== undefined || moved) {
      const name = patch.name === undefined ? existing.name : normalizeName(patch.name)
      if (moved || toEntityNameKey(name) !== toEntityNameKey(existing.name)) {
        assertNameFree(tx, category, name, id)
      }
      if (patch.name !== undefined) changes.name = name
    }
    if (patch.template !== undefined) changes.template = patch.template
    if (patch.fields !== undefined) {
      assertFieldsOf(category, patch.fields)
      const merged = collectFields(category, stored, patch.fields)
      changes.fields = JSON.stringify(merged)
    }
    if (patch.body !== undefined) changes.body = patch.body
    if (
      existing.origin === 'ai' &&
      (patch.name !== undefined ||
        patch.fields !== undefined ||
        patch.body !== undefined ||
        patch.aliases !== undefined)
    ) {
      changes.origin = 'author'
    }
    const updated = tx
      .update(entity)
      .set({ ...changes, modified: new Date().toISOString() })
      .where(eq(entity.id, id))
      .returning()
      .get()
    const renamed = changes.name === undefined ? null : mirrorRename(tx, existing, updated)
    const tagChange =
      patch.aliases === undefined
        ? renamed
        : writeAliases(tx, requireRow(tx, id), patch.aliases, renamed)
    return { entity: toEntity(tx, requireRow(tx, id)), tagChange }
  })
}

/** The row, read again after a write; NOT_FOUND only if it vanished inside the transaction. */
function requireRow(db: EntityDb, id: string): EntityRow {
  const row = getRow(db, id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
  return row
}

/**
 * Writes a sheet's alias list (F-4.14) to its one owner: the linked tag through `updateTag`
 * (whose refusals apply: an alias that is another tag's name or alias is ALREADY_EXISTS), or the
 * sheet's own column when it has no tag. Answers what the bank now owes the windows: the rename
 * `mirrorRename` already made, with `aliased` set when the tag's aliases moved.
 */
function writeAliases(
  db: EntityDb,
  row: EntityRow,
  aliases: readonly string[],
  renamed: EntityTagChange | null
): EntityTagChange | null {
  if (row.tagId === null) {
    db.update(entity)
      .set({ aliases: JSON.stringify(normalizeAliases(aliases, row.name)) })
      .where(eq(entity.id, row.id))
      .run()
    return renamed
  }
  const before = getTag(db, row.tagId)
  const updated = updateTag(db, row.tagId, { aliases: [...aliases] })
  const aliased = JSON.stringify(parseAliases(before?.aliases)) !== JSON.stringify(updated.aliases)
  if (renamed !== null) return { ...renamed, tag: updated, aliased: renamed.aliased || aliased }
  return aliased ? { tag: updated, created: false, renamed: false, aliased } : null
}

/**
 * Adds names to a sheet's aliases (F-4.14) without refusing any: on its tag through
 * `addTagAliases` (names another tag owns are skipped), or on the sheet itself when it has no
 * tag. The context import's apply (F-9.8) records the nicknames the model read this way. Answers
 * the sheet as it now stands and the tag change the windows must hear about, or null.
 */
export function addEntityAliases(db: EntityDb, id: string, names: readonly string[]): EntityWrite {
  return db.transaction((tx) => {
    const row = requireRow(tx, id)
    let tagChange: EntityTagChange | null = null
    if (row.tagId === null) {
      const next = normalizeAliases([...parseAliases(row.aliases), ...names], row.name)
      tx.update(entity)
        .set({ aliases: JSON.stringify(next) })
        .where(eq(entity.id, id))
        .run()
    } else {
      const before = parseAliases(getTag(tx, row.tagId)?.aliases).length
      const updated = addTagAliases(tx, row.tagId, names)
      if (updated.aliases.length !== before) {
        tagChange = { tag: updated, created: false, renamed: false, aliased: true }
      }
    }
    return { entity: toEntity(tx, requireRow(tx, id)), tagChange }
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
    return { entity: toEntity(tx, requireRow(tx, id)), tagChange }
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
    const category = categoryOf(existing.kind, listCategories(tx))
    if (!category.hasImage) {
      throw new AppError('VALIDATION', `A ${category.noun} has no image`, {
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
    return toEntity(tx, updated)
  })
}

/**
 * Deletes an entity (F-9.1) and answers it as it stood, so the caller can take its image file
 * with it (F-9.3). Its tag (F-9.4) is a tag of the bank like any other and stays, with whatever
 * the author has linked it to; only the entity goes.
 *
 * F-5.16: its observed facts cascade with it, and an entity the AI made or one that had any
 * fact (hidden ones included) leaves its kind and name on the dismissed list, so the story-bible job does not create it
 * again from the next scene that names it.
 */
export function deleteEntity(db: EntityDb, id: string): Entity {
  return db.transaction((tx) => {
    const row = getRow(tx, id)
    if (row === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
    if (row.origin === 'ai' || hasFacts(tx, id)) {
      setObservedDismissed(tx, withObservedDismissed(getObservedDismissed(tx), row.kind, row.name))
    }
    const deleted = toEntity(tx, row)
    tx.delete(entity).where(eq(entity.id, id)).run()
    return deleted
  })
}

/** What `mergeEntities` did: the target as it now stands, the sheets it took in, and the tag merge. */
export interface EntityMergeWrite {
  entity: Entity
  /** The merged-away sheets as they stood when deleted (a picture that moved is no longer on one). */
  removed: Entity[]
  tagMerge: TagMergeResult | null
  /** The target's tag after the write, when its aliases changed without a tag merge. */
  aliasedTag: Tag | null
}

/**
 * Merges sheets into one (F-9.10, Organise) in one transaction: each source's values fill the
 * target's empty fields or are added under the target's text when they differ (a field the
 * target's category lacks goes into its Notes, `refileFields`); its page joins the target's; its
 * observed facts move; its tag is merged into the target's (`mergeTags`; a target without a tag
 * takes the first); its picture moves when the target's category has pictures and the target has
 * none; its name and aliases become the target's aliases. The sources are then deleted as
 * `deleteEntity` deletes. The target becomes the author's. VALIDATION when the target is a
 * source; NOT_FOUND for any unknown id.
 */
export function mergeEntities(
  db: EntityDb,
  targetId: string,
  sourceIds: readonly string[]
): EntityMergeWrite {
  const sources = [...new Set(sourceIds)]
  if (sources.includes(targetId)) {
    throw new AppError('VALIDATION', 'A sheet cannot be merged into itself', { id: targetId })
  }
  return db.transaction((tx) => {
    const target = requireRow(tx, targetId)
    const rows = sources.map((id) => requireRow(tx, id))
    const categories = listCategories(tx)
    const category = categoryOf(target.kind, categories)
    const fields: Record<string, string> = {}
    for (const [id, value] of Object.entries(parseEntityFields(target.fields))) {
      if (value !== undefined) fields[id] = value
    }
    let body = target.body ?? ''
    let image = target.image
    const names: string[] = []
    for (const row of rows) {
      const theirs = refileFields(
        categoryOf(row.kind, categories),
        category,
        parseEntityFields(row.fields)
      )
      for (const [id, value] of Object.entries(theirs))
        fields[id] = joinSheetText(fields[id], value)
      body = joinSheetText(body, row.body)
      if (image === null && category.hasImage && row.image !== null) {
        image = row.image
        // The file now belongs to the target, so deleting the source must not take it.
        tx.update(entity).set({ image: null }).where(eq(entity.id, row.id)).run()
      }
      names.push(row.name, ...toEntity(tx, row).aliases)
    }
    tx.update(entity)
      .set({
        fields: JSON.stringify(fields),
        body: body === '' ? target.body : body,
        image,
        origin: 'author',
        modified: new Date().toISOString()
      })
      .where(eq(entity.id, targetId))
      .run()
    tx.update(observedFact)
      .set({ entityId: targetId })
      .where(inArray(observedFact.entityId, sources))
      .run()

    const sourceTags = [
      ...new Set(rows.map((row) => row.tagId).filter((id): id is string => id !== null))
    ].filter((id) => id !== target.tagId)
    let current = requireRow(tx, targetId)
    const first = sourceTags[0]
    if (current.tagId === null && first !== undefined) {
      setTagId(tx, current, first)
      sourceTags.shift()
      current = requireRow(tx, targetId)
    }
    const tagMerge =
      current.tagId !== null && sourceTags.length > 0
        ? mergeTags(tx, current.tagId, sourceTags)
        : null
    const removed = rows.map((row) => deleteEntity(tx, row.id))
    let aliasedTag: Tag | null = null
    if (current.tagId === null) {
      const next = normalizeAliases([...parseAliases(current.aliases), ...names], current.name)
      tx.update(entity)
        .set({ aliases: JSON.stringify(next) })
        .where(eq(entity.id, targetId))
        .run()
    } else {
      const before = parseAliases(getTag(tx, current.tagId)?.aliases).length
      const updated = addTagAliases(tx, current.tagId, names)
      if (updated.aliases.length !== before || first !== undefined) aliasedTag = updated
    }
    return { entity: toEntity(tx, requireRow(tx, targetId)), removed, tagMerge, aliasedTag }
  })
}
