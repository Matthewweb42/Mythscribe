import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  CategoryFieldDef,
  builtinCategory,
  categoryFromInput,
  customCategoryId,
  isKnownCategory,
  mergeCategories,
  type CategoryIcon,
  type NewCategoryInput,
  type StoryCategory
} from '@shared/categories'
import type { CategoryUpdateInput } from '@shared/ipc/contract'
import { storyCategory, type StoryCategoryRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { EntityDb } from './entityStore'

/**
 * The project's story-bible categories in main (F-9.11): the built-in library of
 * `shared/categories.ts` under the author's names for them, and the project's own categories
 * from `story_category`. One owner: every reader of a sheet's template asks here.
 */

const StoredFields = z.array(CategoryFieldDef)

/** A project category's row as the contract's category; null for a rename row or a broken one. */
function rowToCustom(row: StoryCategoryRow): StoryCategory | null {
  if (row.fields === null || row.origin === 'library') return null
  let json: unknown
  try {
    json = JSON.parse(row.fields)
  } catch {
    return null
  }
  const fields = StoredFields.safeParse(json)
  if (!fields.success) return null
  return {
    id: row.id,
    name: row.name,
    noun: row.noun,
    icon: row.icon,
    fields: fields.data,
    hasImage: false,
    tagCategory: 'worldBuilding',
    builtIn: false,
    origin: row.origin,
    hint: row.hint
  }
}

/** Every category of the project, in picker order: the library (renamed where the author did), then the project's own, oldest first. */
export function listCategories(db: EntityDb): StoryCategory[] {
  const rows = db.select().from(storyCategory).orderBy(asc(storyCategory.created)).all()
  const renames = new Map<string, { name: string; noun: string; icon: CategoryIcon }>()
  const custom: StoryCategory[] = []
  for (const row of rows) {
    if (row.fields === null) {
      if (builtinCategory(row.id) !== undefined) {
        renames.set(row.id, { name: row.name, noun: row.noun, icon: row.icon })
      }
      continue
    }
    const category = rowToCustom(row)
    if (category !== null) custom.push(category)
  }
  return mergeCategories(renames, custom)
}

/** The category with this id; VALIDATION for an id the project does not have. */
export function requireCategory(db: EntityDb, id: string): StoryCategory {
  const found = listCategories(db).find((category) => category.id === id)
  if (found === undefined) {
    throw new AppError('VALIDATION', `There is no category "${id}"`, { kind: id })
  }
  return found
}

/** Whether the project has a category with this id (the library's or its own). */
export function hasCategory(db: EntityDb, id: string): boolean {
  return isKnownCategory(id, listCategories(db))
}

const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/** Refuses a name another category already carries (case- and whitespace-insensitively). */
function assertNameFree(
  categories: readonly StoryCategory[],
  name: string,
  exceptId?: string
): void {
  const clash = categories.find(
    (category) => category.id !== exceptId && nameKey(category.name) === nameKey(name)
  )
  if (clash !== undefined) {
    throw new AppError('ALREADY_EXISTS', `A category named "${clash.name}" already exists`, {
      name,
      id: clash.id
    })
  }
}

/**
 * Adds a project category (F-9.11): by hand (`author`), or one the AI invented that the author
 * accepted in a review (`ai`). The id is minted from the name (`c-…`); a name another category
 * carries is ALREADY_EXISTS.
 */
export function createCategory(
  db: EntityDb,
  input: NewCategoryInput,
  origin: 'author' | 'ai'
): StoryCategory {
  const categories = listCategories(db)
  assertNameFree(categories, input.name)
  const id = customCategoryId(
    input.name,
    categories.map((category) => category.id)
  )
  const category = categoryFromInput(id, input, origin)
  const now = new Date().toISOString()
  db.insert(storyCategory)
    .values({
      id,
      name: category.name,
      noun: category.noun,
      icon: category.icon,
      fields: JSON.stringify(category.fields),
      hint: category.hint,
      origin,
      created: now,
      modified: now
    })
    .run()
  return category
}

/**
 * Renames a category, or changes its singular or icon (F-9.11). A library category keeps its
 * template and gets (or updates) a rename row; a project category's own row is updated. NOT_FOUND
 * for an unknown id, ALREADY_EXISTS for a name another category carries.
 */
export function updateCategory(
  db: EntityDb,
  id: string,
  patch: Omit<CategoryUpdateInput, 'id'>
): StoryCategory {
  return db.transaction((tx) => {
    const categories = listCategories(tx)
    const current = categories.find((category) => category.id === id)
    if (current === undefined) throw new AppError('NOT_FOUND', 'Category not found', { id })
    if (patch.name !== undefined) assertNameFree(categories, patch.name, id)
    const next = {
      name: patch.name?.trim() ?? current.name,
      noun: patch.noun?.trim() ?? current.noun,
      icon: patch.icon ?? current.icon
    }
    const now = new Date().toISOString()
    const existing = tx.select().from(storyCategory).where(eq(storyCategory.id, id)).get()
    if (existing === undefined) {
      tx.insert(storyCategory)
        .values({
          id,
          ...next,
          fields: null,
          hint: '',
          origin: 'author',
          created: now,
          modified: now
        })
        .run()
    } else {
      tx.update(storyCategory)
        .set({ ...next, modified: now })
        .where(eq(storyCategory.id, id))
        .run()
    }
    return { ...current, ...next }
  })
}
