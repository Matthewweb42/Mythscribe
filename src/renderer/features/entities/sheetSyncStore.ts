import { create } from 'zustand'
import type { SheetSyncStatus } from '@shared/sheetSync'
import { ipc } from '@renderer/lib/ipc'
import { useEntityDraftStore } from './entityDraftStore'

/**
 * The sheet sync in the renderer (F-9.18): the one owner of which sheets are waiting out their
 * pause, being synced, or failed (`sheetSync:status`, then the `sheetSync:changed` event, which
 * carries the whole list), and the author's one action on a sheet: bring it up to date now. A
 * sheet's state itself (which view is out of date) travels on the entity (`Entity.sync`), so the
 * entity store stays its one owner; a landed sync reaches it as `entity:changed`.
 */
interface SheetSyncStoreState {
  byId: Readonly<Record<string, SheetSyncStatus>>
  load: () => Promise<void>
  /** Write up now / File now / Try again: false when there was nothing to do or AI is off. */
  run: (id: string) => Promise<boolean>
  clear: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null

const toMap = (list: readonly SheetSyncStatus[]): Record<string, SheetSyncStatus> =>
  Object.fromEntries(list.map((status) => [status.entityId, status]))

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
