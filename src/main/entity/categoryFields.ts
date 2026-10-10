import { eq } from 'drizzle-orm'
import {
  CATEGORY_FIELDS_MAX,
  categoryFieldLabel,
  fieldIdFromLabel,
  joinSheetText,
  type StoryCategory
} from '@shared/categories'
import { parseEntityFields, type EntityFieldDef, type EntityFields } from '@shared/entities'
import type { CategoryFieldInput, Entity } from '@shared/ipc/contract'
import { THREAD_KIND } from '@shared/threads'
import { entity, storyCategory } from '../db/schema'
import { AppError } from '../ipc/errors'
import { listCategories } from './categoryStore'
import { getEntity, type EntityDb } from './entityStore'
import { writeAuthorFields } from './factStore'

/**
 * A category's fields edited from Settings › Story bible (F-9.19; requested by the author
 * 2026-10-10): add, remove, rename, reorder, for the library's categories and the project's own.
 * Notes always stays, last. A field keeps its id through a rename, so every sheet keeps its text;
 * a removed field's text moves into Notes on every sheet of the category as "Label: text" (the
 * template-change rule of a move between categories, `refileFields`), so nothing is lost. A
 * library category keeps its edited fields in its `story_category` row (no migration: a library
 * row's `fields` is read as an override). Threads are refused: their fields drive the thread view.
 */
export function setCategoryFields(
  db: EntityDb,
  id: string,
  input: readonly CategoryFieldInput[]
): { category: StoryCategory; entities: Entity[] } {
  if (id === THREAD_KIND) {
    throw new AppError('VALIDATION', 'The Threads fields cannot be changed', { id })
  }
  return db.transaction((tx) => {
    const current = listCategories(tx).find((category) => category.id === id)
    if (current === undefined) throw new AppError('NOT_FOUND', 'Category not found', { id })
    const notes = current.fields.find((field) => field.id === 'notes') ?? {
      id: 'notes',
      label: 'Notes',
      multiline: true
    }
    const wanted = input.filter((field) => field.id !== 'notes')
    if (wanted.length > CATEGORY_FIELDS_MAX) {
      throw new AppError(
        'VALIDATION',
        `A category can have at most ${CATEGORY_FIELDS_MAX} fields besides Notes`,
        { id }
      )
    }
    const fields: EntityFieldDef[] = []
    const labels = new Set<string>([notes.label.toLowerCase()])
    const taken = current.fields.map((field) => field.id)
    for (const field of wanted) {
      const label = field.label.replace(/\s+/g, ' ').trim()
      const key = label.toLowerCase()
      if (label === '') throw new AppError('VALIDATION', 'A field needs a name', { id })
      if (labels.has(key)) {
        throw new AppError('ALREADY_EXISTS', `Two fields are named "${label}"`, { id, label })
      }
      labels.add(key)
      const kept = field.id !== undefined && current.fields.some((each) => each.id === field.id)
      const fieldId =
        kept && field.id !== undefined
          ? field.id
          : fieldIdFromLabel(label, [...taken, ...fields.map((each) => each.id)])
      fields.push({ id: fieldId, label, multiline: field.multiline })
    }
    fields.push(notes)
    const next: StoryCategory = { ...current, fields }

    const now = new Date().toISOString()
    const json = JSON.stringify(fields)
    const row = tx.select().from(storyCategory).where(eq(storyCategory.id, id)).get()
    if (row === undefined) {
      tx.insert(storyCategory)
        .values({
          id,
          name: current.name,
          noun: current.noun,
          icon: current.icon,
          fields: json,
          hint: '',
          origin: 'author',
          created: now,
          modified: now
        })
        .run()
    } else {
      tx.update(storyCategory)
        .set({ fields: json, modified: now })
        .where(eq(storyCategory.id, id))
        .run()
    }

    // A removed field's text moves into Notes on every sheet of the category.
    const removed = new Set(
      current.fields
        .map((field) => field.id)
        .filter((fieldId) => !fields.some((f) => f.id === fieldId))
    )
    const changed: string[] = []
    if (removed.size > 0) {
      const rows = tx.select().from(entity).where(eq(entity.kind, id)).all()
      for (const sheet of rows) {
        const values = parseEntityFields(sheet.fields)
        const lines = [...removed].flatMap((fieldId) => {
          const value = (values[fieldId] ?? '').trim()
          return value === '' ? [] : [`${categoryFieldLabel(current, fieldId)}: ${value}`]
        })
        if (lines.length === 0) continue
        // Only the removed fields move: the sheet's own fields and anything else stay as they are.
        const refiled: EntityFields = { ...values }
        for (const fieldId of removed) delete refiled[fieldId]
        refiled.notes = lines.reduce((text, line) => joinSheetText(text, line), values.notes ?? '')
        writeAuthorFields(tx, sheet.id, refiled)
        tx.update(entity).set({ modified: now }).where(eq(entity.id, sheet.id)).run()
        changed.push(sheet.id)
      }
    }
    return {
      category: next,
      entities: changed.flatMap((sheetId) => {
        const sheet = getEntity(tx, sheetId)
        return sheet === undefined ? [] : [sheet]
      })
    }
  })
}
