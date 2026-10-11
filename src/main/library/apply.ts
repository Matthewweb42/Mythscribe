import { randomUUID } from 'node:crypto'
import { categoryOf, type StoryCategory } from '@shared/categories'
import { NO_UNDO_REASON, changeLabel, changeRunId } from '@shared/changes'
import {
  PROJECT_NOTES_NAME,
  buildReviewEntity,
  keepPicks,
  writesField,
  type ContextSkipped,
  type ContextApplyCounts,
  type ContextFile,
  type ContextReview,
  type ContextReviewEntity
} from '@shared/contextLibrary'
import {
  ENTITY_BODY_MAX,
  ENTITY_FIELD_MAX,
  ENTITY_IMAGES_DIR,
  entityTagName,
  toEntityNameKey,
  type EntityFields
} from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { createCategory, listCategories } from '../entity/categoryStore'
import {
  addEntityAliases,
  createEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  setEntityImage,
  updateEntity,
  type EntityTagChange,
  type EntityWrite
} from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { logChanges, sheetEditChange, type ChangeInput } from '../knowledge/changeLog'
import { addImageAsset, removeImageAsset } from '../project/imageAssets'
import {
  listContextFiles,
  markContextFileProcessed,
  readContextText,
  requireContextFileRow,
  storedPath,
  type LibraryDb
} from './libraryStore'

/** What Apply wrote: the sheets for the renderer's bank, the tags it touched, the library. */
export interface ContextApplyResult extends ContextApplyCounts {
  entities: Entity[]
  tagChanges: EntityTagChange[]
  files: ContextFile[]
  /** F-9.11: every category of the project after Apply, the accepted proposals among them. */
  categories: StoryCategory[]
}

/**
 * F-9.15: a sheet Apply made, for the Changes log: Undo deletes it, with the tag it made, while
 * the author has not written in it since.
 */
function createdChange(sheet: Entity, madeTagId: string | null): ChangeInput {
  return {
    kind: 'record',
    nodeId: null,
    quote: null,
    entityId: sheet.id,
    targetId: sheet.id,
    label: changeLabel(`New sheet: ${sheet.name}`),
    undo: { type: 'deleteSheet', entityId: sheet.id, tagId: madeTagId, modified: sheet.modified }
  }
}

/**
 * F-9.15: a sheet Apply filled, for the Changes log: Undo puts back the fields, page, and aliases
 * Apply wrote, while they still read as Apply left them. Null when none of them moved (only a
 * tag link or a picture, which Undo does not take back).
 */
function updatedChange(before: Entity, after: Entity): ChangeInput | null {
  return sheetEditChange(before, after, `${after.name}: filled from the upload`)
}

/** The sheet a create's ALREADY_EXISTS names (`assertNameFree` carries its id), if that is the refusal. */
function clashOf(db: LibraryDb, err: AppError): Entity | undefined {
  if (err.code !== 'ALREADY_EXISTS') return undefined
  const details = err.details
  if (typeof details !== 'object' || details === null || !('id' in details)) return undefined
  return typeof details.id === 'string' ? getEntity(db, details.id) : undefined
}

/** `existing` with `paragraphs` appended as paragraphs, or VALIDATION when it would be over `max`. */
function appended(
  existing: string,
  paragraphs: readonly string[],
  max: number,
  name: string
): string {
  const added = paragraphs.join('\n\n')
  const text = existing.trim() === '' ? added : `${existing.trimEnd()}\n\n${added}`
  if (text.length > max) {
    throw new AppError(
      'VALIDATION',
      `"${name}" would be longer than ${max.toLocaleString()} characters`,
      {
        name
      }
    )
  }
  return text
}

/** The fields an item writes: its picked values, and its details in Notes when the sheet is structured. */
function fieldPatch(item: ContextReviewEntity, sheet: Entity | null): EntityFields {
  const fields: EntityFields = {}
  for (const field of item.fields) {
    if (writesField(field)) fields[field.field] = field.upload
  }
  const template = sheet?.template ?? 'structured'
  if (item.includeDetails && item.details.length > 0 && template === 'structured') {
    fields.notes = appended(sheet?.fields.notes ?? '', item.details, ENTITY_FIELD_MAX, item.name)
  }
  return fields
}

/**
 * The item as an update of `sheet`, the sheet a create collided with (2026-10-11): its
 * descriptions compared with that sheet again, so an empty field is filled, the same or a
 * covered value is left alone, and a value that disagrees keeps the sheet's (the author did not
 * see that conflict in the review). Details the sheet already holds are dropped.
 */
function asUpdateOf(
  item: ContextReviewEntity,
  sheet: Entity,
  categories: ContextReview['categories']
): ContextReviewEntity {
  if (item.records.length === 0) return { ...item, existingId: sheet.id, kind: sheet.kind }
  const next = buildReviewEntity(item.id, item.records, sheet, categories)
  next.tag = sheet.tagId === null && item.tag !== false ? true : null
  next.images = item.images
  keepPicks(next, [item])
  return next
}

/**
 * Applies a reviewed upload (F-9.8) in one transaction: every included sheet is created or
 * filled (only the fields the review writes: fills, and conflicts where the author picked the
 * upload's value), details are appended to the sheet's Notes (or its page when it is a blank
 * one), tags are created or linked through the F-9.4 path, the Project notes page in the World
 * tab is created or appended to, and the files are marked sorted as of their current text.
 * Pictures are copied into `assets/entities/` before the transaction and removed again if it
 * fails; a picture they replace goes only after it commits. Each sheet is written under its own
 * savepoint (2026-10-11): a new sheet whose name its category already has fills that sheet
 * instead (`asUpdateOf`), and a sheet that still cannot be written (deleted since the review,
 * over the length cap) is left out and reported in `skipped` while the rest applies.
 */
export async function applyContextReview(
  db: LibraryDb,
  folder: string,
  review: ContextReview
): Promise<ContextApplyResult> {
  // The texts are read before the transaction: extraction is asynchronous, a transaction is not.
  const texts = new Map<string, string | null>()
  for (const id of review.fileIds) {
    texts.set(id, await readContextText(folder, requireContextFileRow(db, id)))
  }
  const copies = new Map<string, string>()
  const replacedImages: string[] = []
  let result: Omit<ContextApplyResult, 'files' | 'categories'>
  try {
    for (const item of review.entities) {
      if (!item.include || !categoryOf(item.kind, review.categories).hasImage) continue
      const image = item.images.find((entry) => entry.include)
      if (image === undefined) continue
      const row = requireContextFileRow(db, image.fileId)
      copies.set(
        item.id,
        addImageAsset(folder, ENTITY_IMAGES_DIR, storedPath(folder, row.stored), 'image', row.name)
      )
    }
    result = db.transaction((tx) => {
      // F-9.11: a category the AI proposed is created when Apply writes a sheet into it (the
      // review is where the author accepted, renamed, or declined it); its sheets take its id.
      const madeIds = new Map<string, string>()
      // F-9.15: what Apply wrote, logged as one run of the Changes log with its Undo.
      const changes: ChangeInput[] = []
      for (const category of review.categories) {
        if (!category.proposed) continue
        if (!review.entities.some((item) => item.include && item.kind === category.id)) continue
        const made = createCategory(
          tx,
          {
            name: category.name,
            noun: category.noun,
            icon: category.icon,
            fields: category.fields.filter((field) => field.id !== 'notes').map((f) => f.label),
            hint: category.hint
          },
          'ai'
        )
        madeIds.set(category.id, made.id)
        changes.push({
          kind: 'category',
          nodeId: null,
          quote: null,
          entityId: null,
          targetId: made.id,
          label: changeLabel(`New category: ${made.name}`),
          undo: { type: 'none', reason: NO_UNDO_REASON.category }
        })
      }
      const written = new Map<string, Entity>()
      const tagChanges: EntityTagChange[] = []
      let created = 0
      let updated = 0
      const skipped: ContextSkipped[] = []
      /** One sheet's writes, under its own savepoint so a failure takes back only its own. */
      const applyItem = (inner: LibraryDb, given: ContextReviewEntity): void => {
        let item = given
        let entity: Entity
        /** The sheet as it was before Apply (null for one Apply makes), and the tag it made. */
        let before: Entity | null = null
        let madeTagId: string | null = null
        let made: EntityWrite | null = null
        if (item.existingId === null) {
          const kind = madeIds.get(item.kind) ?? item.kind
          try {
            made = inner.transaction((step) =>
              createEntity(
                step,
                {
                  kind,
                  name: item.name,
                  template: 'structured',
                  fields: fieldPatch(item, null)
                },
                'author',
                { tag: item.tag !== false }
              )
            )
          } catch (err) {
            // The name is taken in that category (a sheet the review did not match, or one an
            // earlier item of this Apply made): the item fills that sheet instead.
            const sheet = err instanceof AppError ? clashOf(inner, err) : undefined
            if (sheet === undefined) throw err
            item = asUpdateOf(item, sheet, review.categories)
          }
        }
        if (made !== null) {
          entity = made.entity
          if (made.tagChange !== null) tagChanges.push(made.tagChange)
          if (made.tagChange?.created === true) madeTagId = made.tagChange.tag.id
          created += 1
        } else {
          const id = item.existingId ?? ''
          const sheet = getEntity(inner, id)
          if (sheet === undefined) {
            throw new AppError('NOT_FOUND', `"${item.name}" is no longer in the story bible`, {
              id
            })
          }
          before = sheet
          const fields = fieldPatch(item, sheet)
          const body =
            item.includeDetails && item.details.length > 0 && sheet.template === 'blank'
              ? appended(sheet.body ?? '', item.details, ENTITY_BODY_MAX, sheet.name)
              : undefined
          entity = sheet
          if (Object.keys(fields).length > 0 || body !== undefined) {
            entity = updateEntity(inner, sheet.id, {
              ...(Object.keys(fields).length > 0 ? { fields } : {}),
              ...(body !== undefined ? { body } : {})
            }).entity
          }
          if (item.tag === true && entity.tagId === null && entityTagName(entity.name) !== '') {
            const link = linkEntityTag(inner, entity.id)
            entity = link.entity
            tagChanges.push(link.tagChange)
          }
          updated += 1
        }
        // F-4.14: every other name the files used for it (a nickname, a title, the second name
        // of a merged match) becomes an alias of the sheet, on its tag when it has one.
        const names = item.records.flatMap((record) => [record.name, ...record.aliases])
        if (names.length > 0) {
          const aliased = addEntityAliases(inner, entity.id, names)
          entity = aliased.entity
          if (aliased.tagChange !== null) tagChanges.push(aliased.tagChange)
        }
        const copy = copies.get(item.id)
        if (copy !== undefined) {
          if (entity.image !== null) replacedImages.push(entity.image)
          entity = setEntityImage(inner, entity.id, copy)
        }
        written.set(entity.id, entity)
        const change =
          before === null ? createdChange(entity, madeTagId) : updatedChange(before, entity)
        if (change !== null) changes.push(change)
      }
      for (const item of review.entities) {
        if (!item.include) continue
        const mark = {
          tags: tagChanges.length,
          images: replacedImages.length,
          changes: changes.length,
          written: new Map(written),
          created,
          updated
        }
        try {
          tx.transaction((inner) => applyItem(inner, item))
        } catch (err) {
          // Expected refusals (a sheet deleted since the review, a page over its cap) leave this
          // sheet out and the rest applies; anything else is a bug and rolls everything back.
          if (!(err instanceof AppError)) throw err
          tagChanges.length = mark.tags
          replacedImages.length = mark.images
          changes.length = mark.changes
          written.clear()
          for (const [id, entity] of mark.written) written.set(id, entity)
          created = mark.created
          updated = mark.updated
          skipped.push({ name: item.name, reason: err.message })
          const copy = copies.get(item.id)
          if (copy !== undefined) {
            copies.delete(item.id)
            removeImageAsset(folder, ENTITY_IMAGES_DIR, copy)
          }
        }
      }
      let notes = false
      if (review.notes.include && review.notes.paragraphs.length > 0) {
        const key = toEntityNameKey(PROJECT_NOTES_NAME)
        const page = listEntities(tx).find(
          (entity) => entity.kind === 'world' && toEntityNameKey(entity.name) === key
        )
        const pageBefore = page === undefined ? null : getEntity(tx, page.id)
        const entity =
          page === undefined
            ? createEntity(
                tx,
                {
                  kind: 'world',
                  name: PROJECT_NOTES_NAME,
                  template: 'blank',
                  body: appended('', review.notes.paragraphs, ENTITY_BODY_MAX, PROJECT_NOTES_NAME)
                },
                'author',
                { tag: false }
              ).entity
            : updateEntity(tx, page.id, {
                body: appended(page.body ?? '', review.notes.paragraphs, ENTITY_BODY_MAX, page.name)
              }).entity
        written.set(entity.id, entity)
        const change =
          pageBefore == null ? createdChange(entity, null) : updatedChange(pageBefore, entity)
        if (change !== null) changes.push(change)
        notes = true
      }
      const at = new Date().toISOString()
      for (const id of review.fileIds) markContextFileProcessed(tx, id, texts.get(id) ?? null, at)
      logChanges(tx, changeRunId('library', randomUUID()), changes, at)
      return { entities: [...written.values()], tagChanges, created, updated, notes, skipped }
    })
  } catch (err) {
    for (const copy of copies.values()) removeImageAsset(folder, ENTITY_IMAGES_DIR, copy)
    throw err
  }
  for (const image of replacedImages) removeImageAsset(folder, ENTITY_IMAGES_DIR, image)
  return { ...result, files: listContextFiles(db), categories: listCategories(db) }
}
