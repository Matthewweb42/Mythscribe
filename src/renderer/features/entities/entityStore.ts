import { create } from 'zustand'
import { ENTITY_KINDS, toEntityNameKey, type EntityKind } from '@shared/entities'
import type { Entity, EntityCreateInput, EntityUpdateInput } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'
import type { EntityView } from './entityView'

/**
 * The one owner of the story bible in the renderer (F-9.2), the tag store's pattern: `load`
 * rebuilds it from `entity:list`; every mutation awaits main and merges the returned row, never
 * re-listing. Errors propagate so the caller can show them, and a failed request leaves the
 * store as it was. It also carries the session-only view state the three entity tabs share
 * (the list/cards choice per kind and the selected entity), so switching sidebar tabs keeps them.
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
  load: () => Promise<void>
  clear: () => void
  /** Creates an entity and merges it; resolves with the stored row (the name comes back trimmed). */
  create: (input: EntityCreateInput) => Promise<Entity>
  /** Patches an entity and replaces it in place; a rename re-sorts the list. */
  update: (id: string, patch: Omit<EntityUpdateInput, 'id'>) => Promise<Entity>
  /** Deletes an entity and drops it from the list (and from the selection). */
  remove: (id: string) => Promise<void>
  setView: (kind: EntityKind, view: EntityView) => void
  select: (id: string | null) => void
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

export const useEntityStore = create<EntityState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,
  view: DEFAULT_VIEW,
  selectedId: null,

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
    set({ byId: {}, ids: [], loaded: false, view: DEFAULT_VIEW, selectedId: null })
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

  setView(kind, view) {
    if (get().view[kind] !== view) set({ view: { ...get().view, [kind]: view } })
  },

  select(id) {
    if (get().selectedId !== id) set({ selectedId: id })
  }
}))

/** Empties the store and invalidates in-flight loads. For tests only. */
export function resetEntityStore(): void {
  useEntityStore.getState().clear()
}
