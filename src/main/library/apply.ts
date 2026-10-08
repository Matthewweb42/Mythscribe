import {
  PROJECT_NOTES_NAME,
  writesField,
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
  kindHasImage,
  toEntityNameKey,
  type EntityFields
} from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import {
  addEntityAliases,
  createEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  setEntityImage,
  updateEntity,
  type EntityTagChange
} from '../entity/entityStore'
import { AppError } from '../ipc/errors'
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
 * Applies a reviewed upload (F-9.8) in one transaction: every included sheet is created or
 * filled (only the fields the review writes: fills, and conflicts where the author picked the
 * upload's value), details are appended to the sheet's Notes (or its page when it is a blank
 * one), tags are created or linked through the F-9.4 path, the Project notes page in the World
 * tab is created or appended to, and the files are marked sorted as of their current text.
 * Pictures are copied into `assets/entities/` before the transaction and removed again if it
 * fails; a picture they replace goes only after it commits. A sheet deleted since the review
 * was made is NOT_FOUND and a new name taken since is ALREADY_EXISTS; either rolls everything back.
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
  let result: Omit<ContextApplyResult, 'files'>
  try {
    for (const item of review.entities) {
      if (!item.include || !kindHasImage(item.kind)) continue
      const image = item.images.find((entry) => entry.include)
      if (image === undefined) continue
      const row = requireContextFileRow(db, image.fileId)
      copies.set(
        item.id,
        addImageAsset(folder, ENTITY_IMAGES_DIR, storedPath(folder, row.stored), 'image', row.name)
      )
    }
    result = db.transaction((tx) => {
      const written = new Map<string, Entity>()
      const tagChanges: EntityTagChange[] = []
      let created = 0
      let updated = 0
      for (const item of review.entities) {
        if (!item.include) continue
        let entity: Entity
        if (item.existingId === null) {
          const write = createEntity(
            tx,
            {
              kind: item.kind,
              name: item.name,
              template: 'structured',
              fields: fieldPatch(item, null)
            },
            'author',
            { tag: item.tag !== false }
          )
          entity = write.entity
          if (write.tagChange !== null) tagChanges.push(write.tagChange)
          created += 1
        } else {
          const sheet = getEntity(tx, item.existingId)
          if (sheet === undefined) {
            throw new AppError('NOT_FOUND', `"${item.name}" is no longer in the story bible`, {
              id: item.existingId
            })
          }
          const fields = fieldPatch(item, sheet)
          const body =
            item.includeDetails && item.details.length > 0 && sheet.template === 'blank'
              ? appended(sheet.body ?? '', item.details, ENTITY_BODY_MAX, sheet.name)
              : undefined
          entity = sheet
          if (Object.keys(fields).length > 0 || body !== undefined) {
            entity = updateEntity(tx, sheet.id, {
              ...(Object.keys(fields).length > 0 ? { fields } : {}),
              ...(body !== undefined ? { body } : {})
            }).entity
          }
          if (item.tag === true && entity.tagId === null && entityTagName(entity.name) !== '') {
            const link = linkEntityTag(tx, entity.id)
            entity = link.entity
            tagChanges.push(link.tagChange)
          }
          updated += 1
        }
        // F-4.14: every other name the files used for it (a nickname, a title, the second name
        // of a merged match) becomes an alias of the sheet, on its tag when it has one.
        const names = item.records.flatMap((record) => [record.name, ...record.aliases])
        if (names.length > 0) {
          const aliased = addEntityAliases(tx, entity.id, names)
          entity = aliased.entity
          if (aliased.tagChange !== null) tagChanges.push(aliased.tagChange)
        }
        const copy = copies.get(item.id)
        if (copy !== undefined) {
          if (entity.image !== null) replacedImages.push(entity.image)
          entity = setEntityImage(tx, entity.id, copy)
        }
        written.set(entity.id, entity)
      }
      let notes = false
      if (review.notes.include && review.notes.paragraphs.length > 0) {
        const key = toEntityNameKey(PROJECT_NOTES_NAME)
        const page = listEntities(tx).find(
          (entity) => entity.kind === 'world' && toEntityNameKey(entity.name) === key
        )
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
        notes = true
      }
      const at = new Date().toISOString()
      for (const id of review.fileIds) markContextFileProcessed(tx, id, texts.get(id) ?? null, at)
      return { entities: [...written.values()], tagChanges, created, updated, notes }
    })
  } catch (err) {
    for (const copy of copies.values()) removeImageAsset(folder, ENTITY_IMAGES_DIR, copy)
    throw err
  }
  for (const image of replacedImages) removeImageAsset(folder, ENTITY_IMAGES_DIR, image)
  return { ...result, files: listContextFiles(db) }
}
