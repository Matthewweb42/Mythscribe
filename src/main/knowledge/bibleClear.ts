import { inArray, isNotNull } from 'drizzle-orm'
import {
  CLEAR_OPTIONS_MAX,
  clearLabel,
  isEmptyClear,
  type ClearCounts,
  type ClearOption,
  type ClearSelection,
  type ClearSnapshot
} from '@shared/bibleClear'
import { categoryOf } from '@shared/categories'
import type { ChangeEntry } from '@shared/changes'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, type TagCategory } from '@shared/tags'
import { EMPTY_DOC } from '@shared/tiptap'
import { notesText } from '../ai/context/scenePanel'
import { contextFile, entity, knowledgeChange, node, tag, todoItem } from '../db/schema'
import { saveNotes } from '../document/notesStore'
import { listCategories } from '../entity/categoryStore'
import { deleteEntity, type EntityDb } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import {
  getDismissedNames,
  getObservedDismissed,
  getTagAliases,
  setDismissedNames,
  setObservedDismissed
} from '../project/settingsStore'
import { deleteTags } from '../tag/tagStore'
import { logChangeEntries } from './changeLog'
import { captureRows } from './clearSnapshot'

/**
 * Clear the story bible (F-5.25): the lines of the chat's card, and the clear itself. Nothing
 * here touches a scene's text or deletes a binder document; removing a tag goes through the tag
 * bank's own delete path, which takes it off its scenes (the links, and the marks it painted).
 */

/** What the request named, read leniently from the model's edit by the resolver. */
export interface ClearWanted {
  sheets: 'all' | ReadonlySet<string>
  tags: 'all' | ReadonlySet<TagCategory>
  library: boolean
  notes: boolean
}

const named = <T extends string>(wanted: 'all' | ReadonlySet<T>, id: T): boolean =>
  wanted === 'all' || wanted.has(id)

/**
 * Every kind the project has something of, as the card lists it: each sheet category in use (by
 * its name; threads are one), each tag category in use, the Library uploads, the documents with
 * notes. Ticked where the request named it. Empty kinds are left out.
 */
export function clearOptions(db: EntityDb, wanted: ClearWanted): ClearOption[] {
  const categories = listCategories(db)
  const sheetCounts = new Map<string, number>()
  for (const row of db.select({ kind: entity.kind }).from(entity).all()) {
    sheetCounts.set(row.kind, (sheetCounts.get(row.kind) ?? 0) + 1)
  }
  const order = new Map(categories.map((category, index) => [category.id, index]))
  const sheets: ClearOption[] = [...sheetCounts.entries()]
    .sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .map(([kind, count]) => ({
      group: 'sheets',
      id: kind,
      label: categoryOf(kind, categories).name,
      count,
      checked: named(wanted.sheets, kind)
    }))
  const tagCounts = new Map<TagCategory, number>()
  for (const row of db.select({ category: tag.category }).from(tag).all()) {
    tagCounts.set(row.category, (tagCounts.get(row.category) ?? 0) + 1)
  }
  const tags: ClearOption[] = TAG_CATEGORIES.flatMap((category) => {
    const count = tagCounts.get(category) ?? 0
    return count === 0
      ? []
      : [
          {
            group: 'tags' as const,
            id: category,
            label: TAG_CATEGORY_LABEL[category],
            count,
            checked: named(wanted.tags, category)
          }
        ]
  })
  const uploads = db.select({ id: contextFile.id }).from(contextFile).all().length
  const notes = documentsWithNotes(db).length
  return [
    ...sheets,
    ...tags,
    ...(uploads > 0
      ? [
          {
            group: 'library' as const,
            id: 'library',
            label: 'Library uploads',
            count: uploads,
            checked: wanted.library
          }
        ]
      : []),
    ...(notes > 0
      ? [
          {
            group: 'notes' as const,
            id: 'notes',
            label: 'Notes on scenes and chapters',
            count: notes,
            checked: wanted.notes
          }
        ]
      : [])
  ].slice(0, CLEAR_OPTIONS_MAX)
}

/** The documents and folders below the sections whose notes hold any text. */
function documentsWithNotes(db: EntityDb): { id: string; title: string; notes: string }[] {
  return db
    .select({ id: node.id, title: node.title, notes: node.notes, parentId: node.parentId })
    .from(node)
    .where(isNotNull(node.notes))
    .all()
    .flatMap((row) =>
      row.parentId === null || row.notes === null || notesText(row.notes, row.id) === ''
        ? []
        : [{ id: row.id, title: row.title, notes: row.notes }]
    )
}

/** What a clear did, for the windows and the chat's card. */
export interface ClearOutcome {
  entry: ChangeEntry
  counts: ClearCounts
  removedEntityIds: string[]
  removedTagIds: string[]
  removedLibraryIds: string[]
  notesNodeIds: string[]
  /** Scenes that lost a tag link or a mention with the tags. */
  linkNodeIds: string[]
}

/**
 * Clears what `selection` ticks (F-5.25) in one transaction and logs it as one Changes row under
 * `runId`, whose Undo puts it all back (`restoreCleared`). The caller takes the backup first.
 * Sheets go through `deleteEntity` and tags through the tag bank's `deleteTags`, so their
 * cascades are the usual ones; the names those paths remember as dismissed are forgotten again,
 * since the author is starting fresh and wants the readings and the next upload to make them
 * again (decided by Claude, unconfirmed). Pictures and uploaded originals stay on disk for the
 * Undo. VALIDATION when the selection names nothing the project has.
 */
export function clearStoryBible(
  db: EntityDb,
  selection: ClearSelection,
  runId: string,
  now: string
): ClearOutcome {
  if (isEmptyClear(selection)) throw new AppError('VALIDATION', 'Nothing is ticked to delete')
  return db.transaction((tx) => {
    const kinds = new Set(selection.sheets)
    const tagCategories = new Set(selection.tags)
    const entityIds = tx
      .select({ id: entity.id, kind: entity.kind })
      .from(entity)
      .all()
      .filter((row) => kinds.has(row.kind))
      .map((row) => row.id)
    const tagIds = tx
      .select({ id: tag.id, category: tag.category })
      .from(tag)
      .all()
      .filter((row) => tagCategories.has(row.category))
      .map((row) => row.id)
    const libraryIds = selection.library
      ? tx
          .select({ id: contextFile.id })
          .from(contextFile)
          .all()
          .map((row) => row.id)
      : []
    const notes = selection.notes ? documentsWithNotes(tx) : []
    const counts: ClearCounts = {
      sheets: entityIds.length,
      tags: tagIds.length,
      library: libraryIds.length,
      notes: notes.length
    }
    if (counts.sheets + counts.tags + counts.library + counts.notes === 0) {
      throw new AppError('VALIDATION', 'There is nothing of that kind left to delete')
    }

    const removedEntities = new Set(entityIds)
    const removedTags = new Set(tagIds)
    const captured: ClearSnapshot['rows'] = [
      { table: 'tag', rows: captureRows(tx, 'tag', ['id'], tagIds) },
      { table: 'entity', rows: captureRows(tx, 'entity', ['id'], entityIds) },
      {
        table: 'fact',
        rows: captureRows(tx, 'fact', ['entity_id', 'object_entity_id'], entityIds)
      },
      { table: 'observed_fact', rows: captureRows(tx, 'observed_fact', ['entity_id'], entityIds) },
      {
        table: 'continuity_finding',
        rows: captureRows(tx, 'continuity_finding', ['entity_id'], entityIds)
      },
      { table: 'document_tag', rows: captureRows(tx, 'document_tag', ['tag_id'], tagIds) },
      {
        table: 'document_tag_dismissal',
        rows: captureRows(tx, 'document_tag_dismissal', ['tag_id'], tagIds)
      },
      { table: 'tag_mention', rows: captureRows(tx, 'tag_mention', ['tag_id'], tagIds) },
      { table: 'context_file', rows: captureRows(tx, 'context_file', ['id'], libraryIds) }
    ]
    const snapshot: ClearSnapshot = {
      rows: captured.filter((group) => group.rows.length > 0),
      sheetTags:
        tagIds.length === 0
          ? []
          : tx
              .select({ id: entity.id, tagId: entity.tagId, aliases: entity.aliases })
              .from(entity)
              .where(inArray(entity.tagId, tagIds))
              .all()
              .flatMap((row) =>
                row.tagId === null || removedEntities.has(row.id)
                  ? []
                  : [{ id: row.id, tagId: row.tagId, aliases: row.aliases }]
              ),
      tagParents:
        tagIds.length === 0
          ? []
          : tx
              .select({ id: tag.id, parentId: tag.parentId })
              .from(tag)
              .where(inArray(tag.parentId, tagIds))
              .all()
              .flatMap((row) =>
                row.parentId === null || removedTags.has(row.id)
                  ? []
                  : [{ id: row.id, parentId: row.parentId }]
              ),
      entityRefs:
        entityIds.length === 0
          ? []
          : [
              ...tx
                .select({ id: knowledgeChange.id, entityId: knowledgeChange.entityId })
                .from(knowledgeChange)
                .where(inArray(knowledgeChange.entityId, entityIds))
                .all()
                .flatMap((row) =>
                  row.entityId === null
                    ? []
                    : [{ table: 'knowledge_change' as const, id: row.id, entityId: row.entityId }]
                ),
              ...tx
                .select({ id: todoItem.id, entityId: todoItem.entityId })
                .from(todoItem)
                .where(inArray(todoItem.entityId, entityIds))
                .all()
                .flatMap((row) =>
                  row.entityId === null
                    ? []
                    : [{ table: 'todo_item' as const, id: row.id, entityId: row.entityId }]
                )
            ],
      notes: notes.map((held) => ({ nodeId: held.id, title: held.title, notes: held.notes })),
      tagAliases: {},
      counts
    }
    const linkNodeIds = [
      ...new Set(
        snapshot.rows
          .filter((group) => group.table === 'document_tag' || group.table === 'tag_mention')
          .flatMap((group) => group.rows)
          .flatMap((row) => (typeof row.node_id === 'string' ? [row.node_id] : []))
      )
    ]

    // The delete paths remember AI-made names as dismissed; a fresh start forgets them again.
    const dismissed = getDismissedNames(tx)
    const observed = getObservedDismissed(tx)
    const aliasesBefore = getTagAliases(tx)
    for (const id of entityIds) deleteEntity(tx, id)
    if (tagIds.length > 0) deleteTags(tx, tagIds)
    if (libraryIds.length > 0)
      tx.delete(contextFile).where(inArray(contextFile.id, libraryIds)).run()
    for (const held of notes) saveNotes(tx, held.id, EMPTY_DOC)
    setDismissedNames(tx, dismissed)
    setObservedDismissed(tx, observed)
    const aliasesAfter = getTagAliases(tx)
    for (const [from, to] of Object.entries(aliasesBefore)) {
      if (aliasesAfter[from] === undefined) snapshot.tagAliases[from] = to
    }

    const [entry] = logChangeEntries(
      tx,
      runId,
      [
        {
          kind: 'clear',
          nodeId: null,
          quote: null,
          entityId: null,
          targetId: 'clear',
          label: clearLabel(counts),
          undo: { type: 'restoreCleared', snapshot }
        }
      ],
      now
    )
    if (entry === undefined) throw new AppError('VALIDATION', 'The clear could not be logged')
    return {
      entry,
      counts,
      removedEntityIds: entityIds,
      removedTagIds: tagIds,
      removedLibraryIds: libraryIds,
      notesNodeIds: notes.map((held) => held.id),
      linkNodeIds
    }
  })
}
