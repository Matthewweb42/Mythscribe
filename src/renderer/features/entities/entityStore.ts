import { create } from 'zustand'
import { ENTITY_KINDS, toEntityNameKey, type EntityKind } from '@shared/entities'
import type {
  EntityExchangeFormat,
  EntityImportAction,
  EntityImportPlan
} from '@shared/entityExchange'
import type { Entity, EntityCreateInput, EntityUpdateInput } from '@shared/ipc/contract'
import { useEditPassViewStore } from '@renderer/features/editPass/editPassViewStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { ipc } from '@renderer/lib/ipc'
import type { EntityView } from './entityView'

/**
 * The one owner of the story bible in the renderer (F-9.2), the tag store's pattern: `load`
 * rebuilds it from `entity:list`; every mutation awaits main and merges the returned row, never
 * re-listing. Errors propagate so the caller can show them, and a failed request leaves the
 * store as it was. It also carries the session-only view state the three entity tabs share
 * (the list/cards choice per kind and the selected entity), so switching sidebar tabs keeps them,
 * and which kind the creation dialog is open for (F-9.3). The open entity's unsaved edits are not
 * here: they live in `entityDraftStore`, which writes them back through `update`.
 */
interface EntityState {
  byId: Record<string, Entity>
  /** Every entity id in the order `entity:list` returns: kind, then name key, then id. */
  ids: string[]
  loaded: boolean
  /** List or cards, per kind; cards until the author toggles. Session state, not persisted. */
  view: Record<EntityKind, EntityView>
  /** The entity the author picked in a tab, if any; F-9.3 opens it in the editor. */
  selectedId: string | null
  /** The kind the creation dialog is open for (F-9.3), or null while it is closed. */
  creating: EntityKind | null
  /**
   * The import under review (F-9.5): what main read from the file and what it would do, with the
   * action the author has chosen per row. Null while no import is in progress; nothing has been
   * written to the project while it is not null.
   */
  importPlan: EntityImportPlan | null
  /** The kind whose tab the import was started from; a CSV with no kind column is read as it. */
  importKind: EntityKind | null
  load: () => Promise<void>
  clear: () => void
  /** Creates an entity and merges it; resolves with the stored row (the name comes back trimmed). */
  create: (input: EntityCreateInput) => Promise<Entity>
  /** Patches an entity and replaces it in place; a rename re-sorts the list. */
  update: (id: string, patch: Omit<EntityUpdateInput, 'id'>) => Promise<Entity>
  /** Deletes an entity and drops it from the list (and from the selection). */
  remove: (id: string) => Promise<void>
  /**
   * Opens the OS image dialog and makes the chosen file the entity's image (F-9.3), merging the
   * returned row; resolves with null when the dialog was cancelled, leaving the entity as it was.
   */
  setImage: (id: string) => Promise<Entity | null>
  /** Removes the entity's image (F-9.3) and merges the returned row. */
  removeImage: (id: string) => Promise<Entity>
  /**
   * Creates or links the tag of the entity's name (F-9.4) and merges both rows — the entity here
   * and the tag into the tag bank, so the chip renders at once. For an entity that has no tag:
   * one made before F-9.4, or one whose tag was deleted.
   */
  linkTag: (id: string) => Promise<Entity>
  /** Upserts a row main pushed (`entity:changed`, F-5.16); a new or renamed one re-sorts. No IPC call. */
  merge: (entity: Entity) => void
  /**
   * Opens the one `entity:changed` subscription (idempotent); call it where the project opens.
   * Main emits it for an entity something other than an `entity:*` call created (F-5.16: the
   * story-bible job met a name with no entity), so the tabs show it without a reload.
   */
  subscribe: () => void
  setView: (kind: EntityKind, view: EntityView) => void
  select: (id: string | null) => void
  /** Opens the creation dialog for `kind` (F-9.3: the quick-add button and the Insert menu). */
  startCreate: (kind: EntityKind) => void
  /** Closes the creation dialog (cancelled, or the entity was created). */
  cancelCreate: () => void
  /**
   * Writes every entity of the kind to a file the author picks (F-9.5) and resolves with where it
   * went and how many rows it carried; null when the save dialog was cancelled.
   */
  exportKind: (
    kind: EntityKind,
    format: EntityExchangeFormat
  ) => Promise<{ path: string; count: number } | null>
  /**
   * Asks main to read an entity file and plan it against the bible (F-9.5), and holds the plan for
   * the review dialog. Resolves with the plan, or null when the open dialog was cancelled.
   * Nothing is written until `commitImport`.
   */
  openImport: (kind: EntityKind) => Promise<EntityImportPlan | null>
  /** Sets what one reviewed row will do; unknown ids and a closed plan are ignored. */
  setImportAction: (itemId: string, action: EntityImportAction) => void
  /** Drops the plan under review; nothing was written. */
  cancelImport: () => void
  /**
   * Applies the reviewed rows in one call (F-9.5), merges what came back into the bank, and clears
   * the plan; resolves with what was done. A failure propagates and leaves the plan open, so the
   * author can read the cause and try again.
   */
  commitImport: () => Promise<{ added: number; merged: number; replaced: number }>
}

/** The `entity:list` order: kind order, then `toEntityNameKey`, then id (as main sorts). */
const compareEntities = (a: Entity, b: Entity): number => {
  const kind = ENTITY_KINDS.indexOf(a.kind) - ENTITY_KINDS.indexOf(b.kind)
  if (kind !== 0) return kind
  const name = toEntityNameKey(a.name).localeCompare(toEntityNameKey(b.name))
  return name !== 0 ? name : a.id.localeCompare(b.id)
}

/** Every id of `byId` in list order. Pure, so it is testable without the store. */
export function orderedIds(byId: Record<string, Entity>): string[] {
  return Object.values(byId)
    .sort(compareEntities)
    .map((entity) => entity.id)
}

const DEFAULT_VIEW: Record<EntityKind, EntityView> = {
  character: 'cards',
  setting: 'cards',
  world: 'cards'
}

/** Bumped by every load() and clear() so a response from a superseded load is dropped. */
let generation = 0
/** The subscription to main's entity writes; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useEntityStore = create<EntityState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,
  view: DEFAULT_VIEW,
  selectedId: null,
  creating: null,
  importPlan: null,
  importKind: null,

  async load() {
    const mine = ++generation
    const entities = await ipc().invoke('entity:list', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    const byId: Record<string, Entity> = {}
    for (const entity of entities) byId[entity.id] = entity
    set({ byId, ids: orderedIds(byId), loaded: true })
  },

  clear() {
    generation++
    set({
      byId: {},
      ids: [],
      loaded: false,
      view: DEFAULT_VIEW,
      selectedId: null,
      creating: null,
      importPlan: null,
      importKind: null
    })
  },

  async create(input) {
    const mine = generation
    const entity = await ipc().invoke('entity:create', input)
    if (mine === generation) {
      const byId = { ...get().byId, [entity.id]: entity }
      set({ byId, ids: orderedIds(byId) })
    }
    return entity
  },

  async update(id, patch) {
    const mine = generation
    const entity = await ipc().invoke('entity:update', { id, ...patch })
    if (mine === generation) {
      const previous = get().byId[id]
      const byId = { ...get().byId, [entity.id]: entity }
      set(previous?.name === entity.name ? { byId } : { byId, ids: orderedIds(byId) })
    }
    return entity
  },

  async remove(id) {
    const mine = generation
    await ipc().invoke('entity:delete', { id })
    if (mine !== generation) return
    const byId = { ...get().byId }
    delete byId[id]
    set({
      byId,
      ids: get().ids.filter((other) => other !== id),
      selectedId: get().selectedId === id ? null : get().selectedId
    })
  },

  async setImage(id) {
    const mine = generation
    const entity = await ipc().invoke('entity:setImage', { id })
    // Null is a cancelled file dialog, not a change: the entity keeps the image it had.
    if (entity !== null && mine === generation) {
      set({ byId: { ...get().byId, [entity.id]: entity } })
    }
    return entity
  },

  async removeImage(id) {
    const mine = generation
    const entity = await ipc().invoke('entity:removeImage', { id })
    // The name cannot change here, so the order is untouched.
    if (mine === generation) set({ byId: { ...get().byId, [entity.id]: entity } })
    return entity
  },

  async linkTag(id) {
    const mine = generation
    const { entity, tag } = await ipc().invoke('entity:linkTag', { id })
    if (mine === generation) {
      // The name cannot change here, so the entity order is untouched.
      set({ byId: { ...get().byId, [entity.id]: entity } })
      useTagStore.getState().merge(tag)
    }
    return entity
  },

  merge(entity) {
    const previous = get().byId[entity.id]
    const byId = { ...get().byId, [entity.id]: entity }
    set(previous?.name === entity.name ? { byId } : { byId, ids: orderedIds(byId) })
  },

  subscribe() {
    unsubscribe ??= ipc().on('entity:changed', (entity) => {
      get().merge(entity)
    })
  },

  setView(kind, view) {
    if (get().view[kind] !== view) set({ view: { ...get().view, [kind]: view } })
  },

  select(id) {
    // F-14.15: an entity page takes the main pane back from the Edits workspace or a report.
    if (id !== null) useEditPassViewStore.getState().close()
    if (get().selectedId !== id) set({ selectedId: id })
  },

  startCreate(kind) {
    set({ creating: kind })
  },

  cancelCreate() {
    if (get().creating !== null) set({ creating: null })
  },

  async exportKind(kind, format) {
    return ipc().invoke('entity:export', { kind, format })
  },

  async openImport(kind) {
    const mine = generation
    const plan = await ipc().invoke('entity:importOpen', { kind })
    if (mine !== generation) return null
    // Null is the native dialog cancelled: no plan, no message, nothing to undo.
    if (plan !== null) set({ importPlan: plan, importKind: kind })
    return plan
  },

  setImportAction(itemId, action) {
    const plan = get().importPlan
    if (plan === null) return
    if (!plan.items.some((item) => item.id === itemId && item.action !== action)) return
    set({
      importPlan: {
        ...plan,
        items: plan.items.map((item) => (item.id === itemId ? { ...item, action } : item))
      }
    })
  },

  cancelImport() {
    if (get().importPlan !== null) set({ importPlan: null, importKind: null })
  },

  async commitImport() {
    const plan = get().importPlan
    if (plan === null) return { added: 0, merged: 0, replaced: 0 }
    const mine = generation
    const { entities, added, merged, replaced } = await ipc().invoke('entity:importCommit', {
      items: plan.items
    })
    if (mine === generation) {
      const byId = { ...get().byId }
      for (const entity of entities) byId[entity.id] = entity
      set({ byId, ids: orderedIds(byId), importPlan: null, importKind: null })
    }
    return { added, merged, replaced }
  }
}))

/** Empties the store, invalidates in-flight loads, and drops the subscription. For tests only. */
export function resetEntityStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useEntityStore.getState().clear()
}
