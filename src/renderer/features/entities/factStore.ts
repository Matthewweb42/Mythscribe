import { create } from 'zustand'
import type { Fact, FactStatus } from '@shared/facts'
import { ipc } from '@renderer/lib/ipc'

/**
 * The dated facts of the records on screen (F-9.13, which replaced F-5.16's observed-fact store),
 * per record id: every fact `fact:listForEntity` answers, the hidden ones included. The views
 * (the sheet, the reference card) call `load` when they mount and read the list through
 * `sheetAt`; main's `fact:changed` re-reads the records already held, so a scene read in the
 * background shows up without a reload. Hiding, restoring, and a status change merge the row main
 * answers.
 */
interface FactState {
  /** The facts of every record asked for so far, oldest first as main lists them. */
  byEntity: Record<string, Fact[]>
  /** Reads one record's facts; a slower, older answer for the same record is dropped. */
  load: (entityId: string) => Promise<void>
  clear: () => void
  /**
   * Hides the stored facts of one value, or restores them: one `fact:setHidden` per id, each
   * answer merged as it arrives, so a failure half-way leaves what was written visible as written.
   * Rejects with the first failure.
   */
  setHidden: (factIds: readonly string[], hidden: boolean) => Promise<void>
  /** Sets the status of the stored facts of one value (D7). Rejects with the first failure. */
  setStatus: (factIds: readonly string[], status: FactStatus) => Promise<void>
  /** Opens the one `fact:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
/** The latest `load` per record; an answer of an earlier one is stale. */
let requests = new Map<string, number>()
let nextRequest = 0
/** The subscription to main's fact writes; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useFactStore = create<FactState>((set, get) => {
  /** Merges one answered fact into the record it belongs to, when that record is held. */
  const merge = (fact: Fact): void => {
    const held = get().byEntity[fact.entityId]
    if (held === undefined) return
    set({
      byEntity: {
        ...get().byEntity,
        [fact.entityId]: held.map((other) => (other.id === fact.id ? fact : other))
      }
    })
  }

  return {
    byEntity: {},

    async load(entityId) {
      const mine = generation
      const request = ++nextRequest
      requests.set(entityId, request)
      const facts = await ipc().invoke('fact:listForEntity', { entityId })
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
        const fact = await ipc().invoke('fact:setHidden', { id, hidden })
        if (mine !== generation) return
        merge(fact)
      }
    },

    async setStatus(factIds, status) {
      const mine = generation
      for (const id of factIds) {
        const fact = await ipc().invoke('fact:setStatus', { id, status })
        if (mine !== generation) return
        merge(fact)
      }
    },

    subscribe() {
      unsubscribe ??= ipc().on('fact:changed', ({ entityIds }) => {
        // Only the records a view has asked for are held; the rest are read when they are opened.
        for (const entityId of entityIds) {
          if (get().byEntity[entityId] === undefined) continue
          // A failed re-read keeps the list as it was; the next event or the next open reads again.
          get()
            .load(entityId)
            .catch(() => undefined)
        }
      })
    }
  }
})

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetFactStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useFactStore.getState().clear()
}
