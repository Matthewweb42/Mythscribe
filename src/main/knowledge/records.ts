import { eq, isNull } from 'drizzle-orm'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { toEntityNameKey, type EntityKind, type EntityOrigin } from '@shared/entities'
import type { Entity, Tag } from '@shared/ipc/contract'
import {
  KNOWLEDGE_INDEX_VERSION,
  RECORD_KIND_FALLBACK,
  RECORD_KIND_FOR_TAG,
  recordNameForTag
} from '@shared/knowledge'
import { isObservedDismissed } from '@shared/observedFacts'
import { entity, tag as tagTable } from '../db/schema'
import {
  createEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  type EntityDb,
  type EntityWrite
} from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import {
  getKnowledgeModel,
  getObservedDismissed,
  setKnowledgeModel
} from '../project/settingsStore'
import { getTagWithUsage } from '../tag/tagStore'

/**
 * One record per name (F-9.12, decision D8): a character, place, or world tag points at one
 * story-bible sheet, its record. Three ways in, all local:
 *
 * - `ensureRecordForTag`: a new name tag gets its record in the same transaction (`tag:create`,
 *   the background tagging job of F-4.13). Silent: a tag that cannot have one stays a label.
 * - `makeRecordForTag`: the author's "Make a record" on a tag (`tag:makeRecord`). Errors reach
 *   the author.
 * - `convertKnowledgeIndex`: once per project (settings `knowledgeModel.index`), on open, every
 *   name tag without a record gets one and every record without a tag gets one.
 *
 * Only `entity` and `tag` rows are written; no scene text is read or changed.
 */

type TagRef = Pick<Tag, 'id' | 'name' | 'category'>

/** The record already pointing at this tag, if any. */
function recordOf(db: EntityDb, tagId: string): Entity | undefined {
  const row = db.select({ id: entity.id }).from(entity).where(eq(entity.tagId, tagId)).get()
  return row === undefined ? undefined : getEntity(db, row.id)
}

/**
 * Gives `tag` a record in `kind`: an untagged sheet of that category with the tag's name is
 * linked to it (the tag carries that sheet's name), otherwise a sheet is created and linked
 * through F-9.4's name link. Throws what `createEntity` throws (a name taken by a sheet that has
 * another tag, a name too long for a sheet).
 */
function giveRecord(
  db: EntityDb,
  tag: TagRef,
  kind: EntityKind,
  origin: EntityOrigin
): EntityWrite {
  const name = recordNameForTag(tag.name)
  const key = toEntityNameKey(name)
  const same = listEntities(db).find(
    (each) => each.kind === kind && toEntityNameKey(each.name) === key && each.tagId === null
  )
  const write =
    same === undefined
      ? createEntity(db, { kind, name, template: origin === 'ai' ? 'blank' : 'structured' }, origin)
      : linkEntityTag(db, same.id)
  if (write.entity.tagId !== tag.id) {
    throw new AppError('VALIDATION', `The sheet "${write.entity.name}" could not take this tag`, {
      tagId: tag.id
    })
  }
  return write
}

/**
 * A new name tag's record (D8), in the caller's transaction (a savepoint): null for a tag that
 * names no thing (tone, content, plot thread, custom), one that already has a record, an AI tag
 * whose sheet the author deleted before (F-5.16's dismissed names), or one whose sheet cannot be
 * made (the savepoint is rolled back and the tag stays a label).
 */
export function ensureRecordForTag(
  db: EntityDb,
  tag: TagRef,
  origin: EntityOrigin
): EntityWrite | null {
  const kind = RECORD_KIND_FOR_TAG[tag.category]
  if (kind === undefined || recordOf(db, tag.id) !== undefined) return null
  if (
    origin === 'ai' &&
    isObservedDismissed(getObservedDismissed(db), kind, recordNameForTag(tag.name))
  ) {
    return null
  }
  try {
    return db.transaction((tx) => giveRecord(tx, tag, kind, origin))
  } catch (err) {
    if (err instanceof AppError) return null
    throw err
  }
}

/**
 * "Make a record" (F-9.12): the record of the tag, made now if it has none — in its category's
 * kind, or World for a label tag. Answers the record, the tag as it stands, and whether
 * anything was written. NOT_FOUND for an unknown tag.
 */
export function makeRecordForTag(
  db: EntityDb,
  tagId: string
): { entity: Entity; tag: Tag; write: EntityWrite | null } {
  return db.transaction((tx) => {
    const tag = getTagWithUsage(tx, tagId)
    if (tag === undefined) throw new AppError('NOT_FOUND', 'Tag not found', { id: tagId })
    const existing = recordOf(tx, tagId)
    if (existing !== undefined) return { entity: existing, tag, write: null }
    const kind = RECORD_KIND_FOR_TAG[tag.category] ?? RECORD_KIND_FALLBACK
    const write = giveRecord(tx, tag, kind, 'author')
    return { entity: write.entity, tag: getTagWithUsage(tx, tagId) ?? tag, write }
  })
}

export interface KnowledgeIndexConversion {
  /** Records made or linked for name tags that had none. */
  records: EntityWrite[]
  /** Records that had no tag and got one. */
  tagged: EntityWrite[]
}

/**
 * F-9.12's one-time conversion, run on project open: idempotent, and a no-op (null) once
 * `knowledgeModel.index` says it ran. In one transaction: every character, place, and world tag
 * without a record gets one (AI tags as AI-made sheets, marked "Added by AI", unless the author
 * deleted that sheet before); then every sheet without a tag gets one, except the context
 * library's Project notes page. The rescan of every scene that follows is the mention scan's,
 * on its silent queue (the scan hash is salted with `MENTION_INDEX_VERSION`).
 */
export function convertKnowledgeIndex(db: EntityDb): KnowledgeIndexConversion | null {
  if (getKnowledgeModel(db).index >= KNOWLEDGE_INDEX_VERSION) return null
  return db.transaction((tx) => {
    const records: EntityWrite[] = []
    const tags = tx
      .select({
        id: tagTable.id,
        name: tagTable.name,
        category: tagTable.category,
        origin: tagTable.origin
      })
      .from(tagTable)
      .orderBy(tagTable.created, tagTable.id)
      .all()
    for (const each of tags) {
      const write = ensureRecordForTag(tx, each, each.origin)
      if (write !== null) records.push(write)
    }
    const tagged: EntityWrite[] = []
    const notesKey = toEntityNameKey(PROJECT_NOTES_NAME)
    const untagged = tx
      .select({ id: entity.id, kind: entity.kind, name: entity.name })
      .from(entity)
      .where(isNull(entity.tagId))
      .orderBy(entity.created, entity.id)
      .all()
    for (const row of untagged) {
      if (row.kind === 'world' && toEntityNameKey(row.name) === notesKey) continue
      try {
        tagged.push(tx.transaction((inner) => linkEntityTag(inner, row.id)))
      } catch (err) {
        // A name with no letters or digits ("???") cannot carry a tag; the sheet stays as it is.
        if (!(err instanceof AppError)) throw err
      }
    }
    setKnowledgeModel(tx, { index: KNOWLEDGE_INDEX_VERSION })
    return { records, tagged }
  })
}
