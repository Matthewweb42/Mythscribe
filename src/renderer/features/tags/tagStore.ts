import { create } from 'zustand'
import type { Tag, TagCreateInput, TagUpdateInput } from '@shared/ipc/contract'
import type { TagTemplateId } from '@shared/tagTemplates'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the tag bank in the renderer (F-4.2). `load` rebuilds it from `tag:list`;
 * every mutation awaits main and merges the returned row, never re-listing. Errors propagate so
 * the caller can show them, and a failed request leaves the store as it was.
 */
interface TagState {
  byId: Record<string, Tag>
  /** Every tag id in the order `tag:list` returns: by name, then id. */
  ids: string[]
  loaded: boolean
  load: () => Promise<void>
  clear: () => void
  /** Creates a tag and merges it; resolves with the stored row (the name comes back kebab-cased). */
  create: (input: TagCreateInput) => Promise<Tag>
  /** Patches a tag and replaces it in place; a rename re-sorts the list. */
  update: (id: string, patch: Omit<TagUpdateInput, 'id'>) => Promise<Tag>
  /** Deletes a tag and drops it from the list. */
  remove: (id: string) => Promise<void>
  /** Loads a template (F-4.3) and merges every created tag in one update; resolves with main's counts. */
  loadTemplate: (template: TagTemplateId) => Promise<{ created: Tag[]; skipped: string[] }>
}

/** The `tag:list` order (name, then id, both by code unit, as SQLite's BINARY collation sorts them). */
const byNameThenId = (a: Tag, b: Tag): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Every id of `byId` in list order. Pure, so it is testable without the store. */
export function orderedIds(byId: Record<string, Tag>): string[] {
  return Object.values(byId)
    .sort(byNameThenId)
    .map((tag) => tag.id)
}

/** Bumped by every load() and clear() so a response from a superseded load is dropped. */
let generation = 0

export const useTagStore = create<TagState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,

  async load() {
    const mine = ++generation
    const tags = await ipc().invoke('tag:list', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    const byId: Record<string, Tag> = {}
    for (const tag of tags) byId[tag.id] = tag
    set({ byId, ids: orderedIds(byId), loaded: true })
  },

  clear() {
    generation++
    set({ byId: {}, ids: [], loaded: false })
  },

  async create(input) {
    const mine = generation
    const tag = await ipc().invoke('tag:create', input)
    if (mine === generation) {
      const byId = { ...get().byId, [tag.id]: tag }
      set({ byId, ids: orderedIds(byId) })
    }
    return tag
  },

  async update(id, patch) {
    const mine = generation
    const tag = await ipc().invoke('tag:update', { id, ...patch })
    if (mine === generation) {
      const previous = get().byId[id]
      const byId = { ...get().byId, [tag.id]: tag }
      set(previous?.name === tag.name ? { byId } : { byId, ids: orderedIds(byId) })
    }
    return tag
  },

  async remove(id) {
    const mine = generation
    await ipc().invoke('tag:delete', { id })
    if (mine !== generation) return
    const byId = { ...get().byId }
    delete byId[id]
    set({ byId, ids: get().ids.filter((other) => other !== id) })
  },

  async loadTemplate(template) {
    const mine = generation
    const result = await ipc().invoke('tag:loadTemplate', { template })
    if (mine === generation && result.created.length > 0) {
      const byId = { ...get().byId }
      for (const tag of result.created) byId[tag.id] = tag
      set({ byId, ids: orderedIds(byId) })
    }
    return result
  }
}))

/** Empties the store and invalidates in-flight loads. For tests only. */
export function resetTagStore(): void {
  useTagStore.getState().clear()
}
