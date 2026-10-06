import { create } from 'zustand'
import type { Tag, TagCreateInput, TagUpdateInput } from '@shared/ipc/contract'
import { dropAliasesTo, type TagAliases } from '@shared/tagExchange'
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
  /**
   * The merge aliases (F-4.9): merged-away tag id → the tag it was merged into. Inline tokens keep
   * the id they were inserted with, so painting and counting them resolves through this map.
   */
  aliases: TagAliases
  /** Rebuilds the bank and the aliases from `tag:list` and `tag:aliases`. */
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
  /** Loads one of the author's saved templates (F-4.11), merged like a built-in one. */
  loadCustomTemplate: (id: string) => Promise<{ created: Tag[]; skipped: string[] }>
  /** Recolors several tags in one request (F-4.9) and replaces each returned row in place. */
  recolorMany: (ids: string[], color: string) => Promise<void>
  /** Deletes several tags in one request (F-4.9) and drops them from the list. */
  removeMany: (ids: string[]) => Promise<void>
  /**
   * Merges `sourceIds` into `targetId` (F-4.9): the target row comes back with its new usage, the
   * merged-away tags leave the list, and the aliases become what main now stores.
   */
  mergeInto: (targetId: string, sourceIds: string[]) => Promise<void>
  /**
   * Imports a tag bank file (F-4.9) through main's open dialog and merges every created tag;
   * resolves with main's counts, or null when the author cancelled the dialog.
   */
  importBank: () => Promise<{ created: Tag[]; skipped: string[] } | null>
  /** Exports the whole bank (F-4.9) through main's save dialog; null when cancelled. */
  exportBank: () => Promise<{ path: string; count: number } | null>
  /**
   * Upserts a row another channel returned (`documentTag:add`/`remove`/`list`, F-4.4), so a
   * usage count moves without re-listing; a changed name re-sorts. No IPC call: the caller made one.
   */
  merge: (tag: Tag) => void
  /**
   * Opens the one `tag:changed` subscription (idempotent); call it where the project opens.
   * Main emits it for a tag something other than a `tag:*` call created or renamed (F-9.4: an
   * entity write), so the bank learns about it without a reload.
   */
  subscribe: () => void
  /**
   * A request from outside the Tags tab to show one tag's detail view (F-4.6, "Open in Tag
   * Manager"); `token` makes a repeat request for the same tag distinct. The tab consumes it.
   */
  pendingSelection: { id: string; token: number } | null
  requestSelection: (id: string) => void
  clearSelectionRequest: () => void
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
/** The subscription to main's tag writes; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useTagStore = create<TagState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,
  aliases: {},
  pendingSelection: null,

  async load() {
    const mine = ++generation
    const [tags, aliases] = await Promise.all([
      ipc().invoke('tag:list', undefined),
      ipc().invoke('tag:aliases', undefined)
    ])
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    const byId: Record<string, Tag> = {}
    for (const tag of tags) byId[tag.id] = tag
    set({ byId, ids: orderedIds(byId), aliases, loaded: true })
  },

  clear() {
    generation++
    set({ byId: {}, ids: [], aliases: {}, loaded: false, pendingSelection: null })
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
    set(dropTags(get(), new Set([id])))
  },

  merge(tag) {
    const previous = get().byId[tag.id]
    const byId = { ...get().byId, [tag.id]: tag }
    set(previous?.name === tag.name ? { byId } : { byId, ids: orderedIds(byId) })
  },

  subscribe() {
    unsubscribe ??= ipc().on('tag:changed', (tag) => {
      get().merge(tag)
    })
  },

  requestSelection(id) {
    set({ pendingSelection: { id, token: (get().pendingSelection?.token ?? 0) + 1 } })
  },

  clearSelectionRequest() {
    if (get().pendingSelection !== null) set({ pendingSelection: null })
  },

  async loadTemplate(template) {
    const mine = generation
    const result = await ipc().invoke('tag:loadTemplate', { template })
    if (mine === generation) mergeCreated(result.created)
    return result
  },

  async loadCustomTemplate(id) {
    const mine = generation
    const result = await ipc().invoke('tag:loadCustomTemplate', { id })
    if (mine === generation) mergeCreated(result.created)
    return result
  },

  async recolorMany(ids, color) {
    const mine = generation
    const tags = await ipc().invoke('tag:recolor', { ids, color })
    if (mine !== generation) return
    const byId = { ...get().byId }
    for (const tag of tags) byId[tag.id] = tag
    set({ byId })
  },

  async removeMany(ids) {
    const mine = generation
    await ipc().invoke('tag:deleteMany', { ids })
    if (mine !== generation) return
    set(dropTags(get(), new Set(ids)))
  },

  async mergeInto(targetId, sourceIds) {
    const mine = generation
    const result = await ipc().invoke('tag:merge', { targetId, sourceIds })
    if (mine !== generation) return
    const { byId } = dropTags(get(), new Set(result.removedIds))
    byId[result.target.id] = result.target
    set({ byId, ids: orderedIds(byId), aliases: result.aliases })
  },

  async importBank() {
    const mine = generation
    const result = await ipc().invoke('tag:import', {})
    if (result !== null && mine === generation) mergeCreated(result.created)
    return result
  },

  async exportBank() {
    return ipc().invoke('tag:export', {})
  }
}))

/** Merges the tags a template or an import created (F-4.3, F-4.9, F-4.11), in one update. */
function mergeCreated(created: readonly Tag[]): void {
  if (created.length === 0) return
  const byId = { ...useTagStore.getState().byId }
  for (const tag of created) byId[tag.id] = tag
  useTagStore.setState({ byId, ids: orderedIds(byId) })
}

/**
 * The bank without `removed`; deleting tags never reorders the rest. Aliases that led to a
 * removed tag go too, as main drops them (F-4.9), so a token of it reads as deleted.
 */
function dropTags(
  state: Pick<TagState, 'byId' | 'ids' | 'aliases'>,
  removed: Set<string>
): Pick<TagState, 'byId' | 'ids' | 'aliases'> {
  const byId = { ...state.byId }
  for (const id of removed) delete byId[id]
  return {
    byId,
    ids: state.ids.filter((id) => !removed.has(id)),
    aliases: dropAliasesTo(state.aliases, [...removed])
  }
}

/** Empties the store, invalidates in-flight loads, and drops the subscription. For tests only. */
export function resetTagStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useTagStore.getState().clear()
}
