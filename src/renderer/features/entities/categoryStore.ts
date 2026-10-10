import { create } from 'zustand'
import {
  ALL_BUILTIN_CATEGORIES,
  categoryOf,
  type NewCategoryInput,
  type StoryCategory
} from '@shared/categories'
import type { CategoryFieldInput, CategoryUpdateInput } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'
import { useEntityStore } from './entityStore'

/**
 * The story-bible categories in the renderer (F-9.11): the one owner of `category:list` — the
 * built-in library under the author's names for it, then the project's own categories. Until it
 * loads, the library alone stands in, so a sheet always has a template to show. Every mutation
 * awaits main and replaces the changed category in place.
 */
interface CategoryState {
  categories: readonly StoryCategory[]
  loaded: boolean
  /** Whether the "New category" dialog is open (the section picker's last item opens it). */
  creating: boolean
  load: () => Promise<void>
  startCreate: () => void
  cancelCreate: () => void
  clear: () => void
  /** Replaces the list with what main answered elsewhere (`library:apply` creates accepted proposals). */
  replace: (categories: readonly StoryCategory[]) => void
  /** Adds a project category by hand; resolves with it as stored. */
  create: (input: NewCategoryInput) => Promise<StoryCategory>
  /** Renames a category or changes its singular or icon. */
  update: (id: string, patch: Omit<CategoryUpdateInput, 'id'>) => Promise<StoryCategory>
  /**
   * F-9.19: replaces a category's fields (Settings › Story bible); the sheets whose text moved
   * into Notes are merged into the entity store.
   */
  setFields: (id: string, fields: CategoryFieldInput[]) => Promise<StoryCategory>
}

/** Bumped by every load() and clear() so an answer for a closed project is dropped. */
let generation = 0

export const useCategoryStore = create<CategoryState>((set, get) => ({
  categories: ALL_BUILTIN_CATEGORIES,
  loaded: false,
  creating: false,

  startCreate() {
    set({ creating: true })
  },

  cancelCreate() {
    set({ creating: false })
  },

  async load() {
    const mine = ++generation
    const categories = await ipc().invoke('category:list', undefined)
    if (mine !== generation) return
    set({ categories, loaded: true })
  },

  clear() {
    generation++
    set({ categories: ALL_BUILTIN_CATEGORIES, loaded: false, creating: false })
  },

  replace(categories) {
    set({ categories })
  },

  async create(input) {
    const mine = generation
    const category = await ipc().invoke('category:create', input)
    if (mine === generation) set({ categories: [...get().categories, category] })
    return category
  },

  async setFields(id, fields) {
    const mine = generation
    const { category, entities } = await ipc().invoke('category:setFields', { id, fields })
    if (mine === generation) {
      set({ categories: get().categories.map((c) => (c.id === id ? category : c)) })
      for (const entity of entities) useEntityStore.getState().merge(entity)
    }
    return category
  },

  async update(id, patch) {
    const mine = generation
    const category = await ipc().invoke('category:update', { id, ...patch })
    if (mine === generation) {
      set({ categories: get().categories.map((c) => (c.id === id ? category : c)) })
    }
    return category
  }
}))

/** The category of a sheet: the project's (renamed or its own), the library's, or a generic one. */
export function useCategory(id: string): StoryCategory {
  return useCategoryStore((s) => categoryOf(id, s.categories))
}

/** The same, outside React. */
export function getCategory(id: string): StoryCategory {
  return categoryOf(id, useCategoryStore.getState().categories)
}

/** Back to the library alone, in-flight loads dropped. For tests. */
export function resetCategoryStore(): void {
  useCategoryStore.getState().clear()
}
