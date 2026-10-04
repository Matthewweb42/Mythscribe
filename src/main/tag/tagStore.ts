import { randomUUID } from 'node:crypto'
import type { RunResult } from 'better-sqlite3'
import { and, asc, count, eq, inArray, ne, type SQL } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { Tag, TagCreateInput, TagUpdateInput } from '@shared/ipc/contract'
import { DEFAULT_CATEGORY_COLOR, toTagName } from '@shared/tags'
import {
  dropAliasesTo,
  mergeAliases,
  type TagAliases,
  type TagExchangeRecord
} from '@shared/tagExchange'
import {
  getDismissedNames,
  getTagAliases,
  setDismissedNames,
  setTagAliases
} from '../project/settingsStore'
import { tagTemplateById, type TagTemplateId } from '@shared/tagTemplates'
import type * as schema from '../db/schema'
import {
  documentTag,
  documentTagDismissal,
  entity,
  tag,
  type TagInsert,
  type TagRow
} from '../db/schema'
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
      trackMentions: tag.trackMentions,
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

/**
 * The id of the tag that carries the (already normalized) name, or undefined when it is free.
 * F-9.4 looks an entity's tag up with it before making a second one under the same name.
 */
export function findTagByName(db: TagDb, name: string): string | undefined {
  return findByName(db, name)
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
  if (wouldCycle(db, id, parent.id)) {
    throw new AppError('VALIDATION', 'A tag cannot be nested under itself or its own child', {
      id,
      parentId: parent.id
    })
  }
}

/**
 * Creates a tag (F-4.1): the name is kebab-cased and must be unique after normalization, the
 * color defaults to the category's, and the parent (when given) must exist. Mention tracking
 * (F-4.12) starts on. Returns the tag with `usageCount: 0`. `origin` is `ai` only when the
 * background tagging job makes the tag (F-4.13).
 */
export function createTag(
  db: TagDb,
  input: TagCreateInput,
  origin: TagRow['origin'] = 'author'
): Tag {
  return db.transaction((tx) => {
    const name = normalizeName(input.name)
    assertNameFree(tx, name)
    const parentId = input.parentId ?? null
    if (parentId !== null) assertParentExists(tx, parentId)
    return insertTag(tx, { ...input, name, parentId }, origin)
  })
}

/** The one insert: a validated, normalized name and a checked parent go in; the row comes back. */
function insertTag(
  db: TagDb,
  input: {
    name: string
    category: Tag['category']
    color?: string
    parentId: string | null
    trackMentions?: boolean
  },
  origin: TagRow['origin'] = 'author'
): Tag {
  const now = new Date().toISOString()
  const row: TagInsert = {
    id: randomUUID(),
    name: input.name,
    category: input.category,
    color: input.color ?? DEFAULT_CATEGORY_COLOR[input.category],
    parentId: input.parentId,
    // F-4.12: a new tag is looked for from its first save; the author turns it off per tag (and
    // an imported bank, F-4.9, brings the switch with it).
    trackMentions: input.trackMentions ?? true,
    origin,
    created: now,
    modified: now
  }
  const { origin: _origin, ...inserted } = db.insert(tag).values(row).returning().get()
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
 * descendants is refused with VALIDATION. Stamps `modified`. A patch of the name, category,
 * color, or parent makes an AI-made tag the author's (F-4.13); the tracking switch alone does not.
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
    // F-4.12: the caller acts on the switch itself (deleting the recorded mentions, or rescanning
    // the manuscript); the store only records it.
    if (patch.trackMentions !== undefined) changes.trackMentions = patch.trackMentions
    if (existing.origin === 'ai' && Object.keys(changes).some((key) => key !== 'trackMentions')) {
      changes.origin = 'author'
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
 * every connection). Deleting a tag the background job made (F-4.13) records its name with the
 * dismissed proposals (F-4.12b), in the same transaction, so neither proposes or makes it again.
 * Merge aliases (F-4.9) that led to the tag go with it.
 */
export function deleteTag(db: TagDb, id: string): void {
  db.transaction((tx) => removeTags(tx, [id]))
}

/** Deletes several tags at once (F-4.9), each as `deleteTag` does; NOT_FOUND deletes nothing. */
export function deleteTags(db: TagDb, ids: readonly string[]): void {
  db.transaction((tx) => removeTags(tx, ids))
}

/**
 * The one delete path, inside the caller's transaction: every id must exist (NOT_FOUND
 * otherwise, before anything is written), the rows go, AI-made names join the dismissed
 * proposals, and aliases leading to a deleted tag are dropped.
 */
function removeTags(tx: TagDb, ids: readonly string[]): void {
  const unique = [...new Set(ids)]
  const rows = unique.map((id) => {
    const existing = getTag(tx, id)
    if (!existing) throw new AppError('NOT_FOUND', 'Tag not found', { id })
    return existing
  })
  if (rows.length === 0) return
  tx.delete(tag).where(inArray(tag.id, unique)).run()
  const aiNames = rows.filter((row) => row.origin === 'ai').map((row) => row.name)
  if (aiNames.length > 0) {
    const stored = getDismissedNames(tx)
    const added = aiNames.filter((name) => !stored.names.includes(name))
    if (added.length > 0) setDismissedNames(tx, { names: [...stored.names, ...added] })
  }
  const aliases = getTagAliases(tx)
  const kept = dropAliasesTo(aliases, unique)
  if (Object.keys(kept).length !== Object.keys(aliases).length) setTagAliases(tx, kept)
}

/**
 * Recolors several tags at once (F-4.9) in one transaction and answers the updated rows in the
 * given order (a repeated id once). A recolor makes an AI-made tag the author's, as `updateTag`
 * does. NOT_FOUND writes nothing.
 */
export function recolorTags(db: TagDb, ids: readonly string[], color: string): Tag[] {
  return db.transaction((tx) => {
    const unique = [...new Set(ids)]
    for (const id of unique) {
      if (!getTag(tx, id)) throw new AppError('NOT_FOUND', 'Tag not found', { id })
    }
    const modified = new Date().toISOString()
    tx.update(tag).set({ color, origin: 'author', modified }).where(inArray(tag.id, unique)).run()
    return unique.map((id) => {
      const updated = getTagWithUsage(tx, id)
      if (!updated) throw new AppError('NOT_FOUND', 'Tag not found', { id })
      return updated
    })
  })
}

/** What a merge did: the target with its new usage, the tags gone, the aliases now stored. */
export interface TagMergeResult {
  target: Tag
  removedIds: string[]
  aliases: TagAliases
  /** Every node whose document links changed, for `documentTag:changed`. */
  nodeIds: string[]
  /** Every entity now linked to the target instead of a source, for `entity:changed`. */
  entityIds: string[]
}

/**
 * Merges `sourceIds` into `targetId` (F-4.9) in one transaction. Each source's document links
 * move to the target; a node that already carries the target keeps one link, the author's if
 * either was. Tagging dismissals move too, except on a node that carries the target (the author
 * linking a tag lifts its dismissal, so the two never stand together). Entities linked to a
 * source (F-9.4) link to the target. The sources are then deleted as `deleteTag` does, and each
 * becomes an alias of the target (aliases that led to a source now lead to the target). The
 * target keeps its name, category, color, and origin. VALIDATION when the target is a source;
 * NOT_FOUND for any unknown id.
 */
export function mergeTags(
  db: TagDb,
  targetId: string,
  sourceIds: readonly string[]
): TagMergeResult {
  const sources = [...new Set(sourceIds)]
  if (sources.includes(targetId)) {
    throw new AppError('VALIDATION', 'A tag cannot be merged into itself', { id: targetId })
  }
  return db.transaction((tx) => {
    if (!getTag(tx, targetId)) throw new AppError('NOT_FOUND', 'Tag not found', { id: targetId })
    for (const id of sources) {
      if (!getTag(tx, id)) throw new AppError('NOT_FOUND', 'Tag not found', { id })
    }
    const nodeIds = new Set<string>()
    const links = tx
      .select()
      .from(documentTag)
      .where(inArray(documentTag.tagId, sources))
      .orderBy(asc(documentTag.created), asc(documentTag.id))
      .all()
    for (const link of links) {
      nodeIds.add(link.nodeId)
      const kept = tx
        .select()
        .from(documentTag)
        .where(and(eq(documentTag.nodeId, link.nodeId), eq(documentTag.tagId, targetId)))
        .get()
      if (kept === undefined) {
        tx.update(documentTag).set({ tagId: targetId }).where(eq(documentTag.id, link.id)).run()
      } else if (link.source === 'author' && kept.source !== 'author') {
        tx.update(documentTag).set({ source: 'author' }).where(eq(documentTag.id, kept.id)).run()
      }
      // A duplicate link left on the source cascades away with it.
    }
    const linked = new Set(
      tx
        .select({ nodeId: documentTag.nodeId })
        .from(documentTag)
        .where(eq(documentTag.tagId, targetId))
        .all()
        .map((row) => row.nodeId)
    )
    const dismissals = tx
      .select({ nodeId: documentTagDismissal.nodeId })
      .from(documentTagDismissal)
      .where(inArray(documentTagDismissal.tagId, sources))
      .all()
    for (const { nodeId } of dismissals) {
      if (linked.has(nodeId)) continue
      tx.insert(documentTagDismissal)
        .values({ nodeId, tagId: targetId })
        .onConflictDoNothing()
        .run()
    }
    const entityIds = tx
      .select({ id: entity.id })
      .from(entity)
      .where(inArray(entity.tagId, sources))
      .all()
      .map((row) => row.id)
    tx.update(entity).set({ tagId: targetId }).where(inArray(entity.tagId, sources)).run()
    // The aliases are redirected before the delete, so its drop of aliases to the sources finds
    // nothing left to drop.
    setTagAliases(tx, mergeAliases(getTagAliases(tx), sources, targetId))
    removeTags(tx, sources)
    const target = getTagWithUsage(tx, targetId)
    if (!target) throw new AppError('NOT_FOUND', 'Tag not found', { id: targetId })
    return {
      target,
      removedIds: sources,
      aliases: getTagAliases(tx),
      nodeIds: [...nodeIds],
      entityIds
    }
  })
}

/** The whole bank as tag-bank file records (F-4.9), ordered by name; a parent travels by name. */
export function exportTagBank(db: TagDb): TagExchangeRecord[] {
  const rows = listTags(db)
  const nameById = new Map(rows.map((row) => [row.id, row.name]))
  return rows.map((row) => ({
    name: row.name,
    category: row.category,
    color: row.color,
    parent: row.parentId === null ? null : (nameById.get(row.parentId) ?? null),
    trackMentions: row.trackMentions
  }))
}

/**
 * Imports tag-bank records (F-4.9) in one transaction: a record whose (normalized) name is not in
 * the bank is created with its category, color, and tracking switch; a taken name is skipped,
 * never overwritten, as templates do. Parents are linked in a second pass, by name, for created
 * tags only, when the parent exists after the import and the link would not make a cycle.
 * `created` holds the new rows (with their parents) and `skipped` the taken names, in file order.
 */
export function importTagBank(
  db: TagDb,
  records: readonly TagExchangeRecord[]
): { created: Tag[]; skipped: string[] } {
  return db.transaction((tx) => {
    const made: { id: string; parent: string | null }[] = []
    const skipped: string[] = []
    for (const record of records) {
      const name = normalizeName(record.name)
      if (findByName(tx, name) !== undefined) {
        skipped.push(name)
        continue
      }
      const created = insertTag(tx, {
        name,
        category: record.category,
        color: record.color,
        parentId: null,
        trackMentions: record.trackMentions
      })
      made.push({
        id: created.id,
        parent: record.parent === null ? null : toTagName(record.parent)
      })
    }
    for (const { id, parent } of made) {
      if (parent === null || parent === '') continue
      const parentId = findByName(tx, parent)
      if (parentId === undefined || wouldCycle(tx, id, parentId)) continue
      tx.update(tag).set({ parentId }).where(eq(tag.id, id)).run()
    }
    const created = made.map(({ id }) => {
      const row = getTagWithUsage(tx, id)
      if (!row) throw new AppError('NOT_FOUND', 'Tag not found', { id })
      return row
    })
    return { created, skipped }
  })
}

/**
 * Whether nesting `id` under `parentId` would put the tag under itself or its own child: walks
 * `parentId` up from the proposed parent and answers true if the walk reaches `id`.
 */
function wouldCycle(db: TagDb, id: string, parentId: string): boolean {
  for (let current = getTag(db, parentId); current;) {
    if (current.id === id) return true
    current = current.parentId === null ? undefined : getTag(db, current.parentId)
  }
  return false
}
