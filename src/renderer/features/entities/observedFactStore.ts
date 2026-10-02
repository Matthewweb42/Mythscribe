import { create } from 'zustand'
import type { ObservedFact } from '@shared/observedFacts'
import { ipc } from '@renderer/lib/ipc'

/**
 * What the manuscript states about the entities on screen (F-5.16), per entity id: every observed
 * fact of an entity a view has asked for, the hidden ones included. The views (the entity page,
 * the reference card) call `load` when they mount and read the list through `groupFacts`; main's
 * `observedFact:changed` re-reads the entities already held, so a scene re-read in the background
 * shows up without a reload. Hiding and restoring merge the row main answers.
 */
interface ObservedFactState {
  /** The facts of every entity asked for so far, oldest first as main lists them. */
  byEntity: Record<string, ObservedFact[]>
  /** Reads one entity's facts; a slower, older answer for the same entity is dropped. */
  load: (entityId: string) => Promise<void>
  clear: () => void
  /**
   * Hides the stored facts of one row, or restores them (F-5.16): one `observedFact:setHidden`
   * per id, each answer merged as it arrives, so a failure half-way leaves what was written
   * visible as written. Rejects with the first failure.
   */
  setHidden: (factIds: readonly string[], hidden: boolean) => Promise<void>
  /** Opens the one `observedFact:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
/** The latest `load` per entity; an answer of an earlier one is stale. */
let requests = new Map<string, number>()
let nextRequest = 0
/** The subscription to main's fact writes; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useObservedFactStore = create<ObservedFactState>((set, get) => ({
  byEntity: {},

  async load(entityId) {
    const mine = generation
    const request = ++nextRequest
    requests.set(entityId, request)
    const facts = await ipc().invoke('observedFact:listForEntity', { entityId })
    if (mine !== generation || requests.get(entityId) !== request) return
    set({ byEntity: { ...get().byEntity, [entityId]: facts } })
  },

  clear() {
    generation++
    requests = new Map()
    set({ byEntity: {} })
  },

  async setHidden(factIds, hidden) {
    const mine = generation
    for (const id of factIds) {
      const fact = await ipc().invoke('observedFact:setHidden', { id, hidden })
      if (mine !== generation) return
      const held = get().byEntity[fact.entityId]
      if (held === undefined) continue
      set({
        byEntity: {
          ...get().byEntity,
          [fact.entityId]: held.map((other) => (other.id === fact.id ? fact : other))
        }
      })
    }
  },

  subscribe() {
    unsubscribe ??= ipc().on('observedFact:changed', ({ entityIds }) => {
      // Only the entities a view has asked for are held; the rest are read when they are opened.
      for (const entityId of entityIds) {
        if (get().byEntity[entityId] === undefined) continue
        // A failed re-read keeps the list as it was; the next event or the next open reads again.
        get()
          .load(entityId)
          .catch(() => undefined)
      }
    })
  }
}))

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetObservedFactStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useObservedFactStore.getState().clear()
}
