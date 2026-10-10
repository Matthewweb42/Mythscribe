import { create } from 'zustand'
import type { Entity } from '@shared/ipc/contract'
import type { SheetSyncStatus } from '@shared/sheetSync'
import { ipc } from '@renderer/lib/ipc'
import { useEntityDraftStore } from './entityDraftStore'
import { useEntityStore } from './entityStore'

/**
 * The sheet sync in the renderer (F-9.18): the one owner of which sheets are waiting out their
 * pause, being synced, or failed (`sheetSync:status`, then the `sheetSync:changed` event, which
 * carries the whole list), and the author's three actions on a sheet: bring it up to date now,
 * apply what was held for them (chat mode Ask or Plan), or dismiss it. A sheet's state itself
 * (which view is out of date, what is held) travels on the entity (`Entity.sync`), so the entity
 * store stays its one owner; this store merges the rows main answers into it.
 */
interface SheetSyncStoreState {
  byId: Readonly<Record<string, SheetSyncStatus>>
  load: () => Promise<void>
  /** Write up now / File now / Try again: false when there was nothing to do or AI is off. */
  run: (id: string) => Promise<boolean>
  apply: (id: string) => Promise<Entity>
  dismiss: (id: string) => Promise<Entity>
  clear: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null

const toMap = (list: readonly SheetSyncStatus[]): Record<string, SheetSyncStatus> =>
  Object.fromEntries(list.map((status) => [status.entityId, status]))

/** Merges a sheet main answered into the entity store (the open page adopts it, `EntityEditor`). */
function merge(entity: Entity): Entity {
  useEntityStore.getState().merge(entity)
  return entity
}

export const useSheetSyncStore = create<SheetSyncStoreState>((set) => ({
  byId: {},

  async load() {
    unsubscribe ??= ipc().on('sheetSync:changed', (list) => {
      set({ byId: toMap(list) })
    })
    const mine = ++generation
    const list = await ipc().invoke('sheetSync:status', undefined)
    if (mine === generation) set({ byId: toMap(list) })
  },

  async run(id) {
    // The page's last keystrokes first: main reads what is saved.
    await useEntityDraftStore.getState().flush()
    return ipc().invoke('sheetSync:run', { id })
  },

  async apply(id) {
    await useEntityDraftStore.getState().flush()
    return merge(await ipc().invoke('sheetSync:apply', { id }))
  },

  async dismiss(id) {
    return merge(await ipc().invoke('sheetSync:dismiss', { id }))
  },

  clear() {
    generation++
    unsubscribe?.()
    unsubscribe = null
    set({ byId: {} })
  }
}))

/** Empties the store and drops the subscription. For tests only. */
export function resetSheetSyncStore(): void {
  useSheetSyncStore.getState().clear()
}
