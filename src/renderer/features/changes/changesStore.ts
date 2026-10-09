import { create } from 'zustand'
import { CHANGES_PAGE, type ChangeEntry, type ChangeUndoResult } from '@shared/changes'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * The Changes section (F-9.13): the renderer owner of the log of what the background reading
 * applied on its own, newest first, a page at a time. Main's `changes:changed` re-reads the pages
 * held. An undo merges the rows main marked undone, and drops the sheets and tags it deleted from
 * their stores (the other moves arrive as `fact:changed` and `documentTag:changed`).
 */
interface ChangesState {
  entries: ChangeEntry[]
  /** Whether older rows exist past the last page held. */
  more: boolean
  /** The ids of the rows and runs being undone, for the buttons. */
  pending: string[]
  /** Reads the newest page again, as many rows as are held (at least one page). */
  load: () => Promise<void>
  /** Reads the next older page. */
  loadMore: () => Promise<void>
  undo: (id: string) => Promise<void>
  undoRun: (runId: string) => Promise<void>
  clear: () => void
  /** Opens the one `changes:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
let latest = 0
let unsubscribe: (() => void) | null = null

export const useChangesStore = create<ChangesState>((set, get) => {
  const applyUndo = (result: ChangeUndoResult): void => {
    const undone = new Map(result.entries.map((entry) => [entry.id, entry]))
    set({ entries: get().entries.map((entry) => undone.get(entry.id) ?? entry) })
    const entities = useEntityStore.getState()
    entities.forget(result.removedEntityIds)
    // A sheet whose tag went keeps no tag, as main cleared it (F-9.4: the sheet outlives its tag).
    const tags = new Set(result.removedTagIds)
    for (const id of entities.ids) {
      const entity = useEntityStore.getState().byId[id]
      if (entity?.tagId != null && tags.has(entity.tagId))
        entities.merge({ ...entity, tagId: null })
    }
    useTagStore.getState().forget(result.removedTagIds)
  }
  const track = async (key: string, task: () => Promise<ChangeUndoResult>): Promise<void> => {
    const mine = generation
    set({ pending: [...get().pending, key] })
    try {
      const result = await task()
      if (mine === generation) applyUndo(result)
    } finally {
      if (mine === generation) set({ pending: get().pending.filter((each) => each !== key) })
    }
  }

  return {
    entries: [],
    more: false,
    pending: [],

    async load() {
      const mine = generation
      const request = ++latest
      const limit = Math.max(CHANGES_PAGE, get().entries.length)
      const page = await ipc().invoke('changes:list', { limit })
      if (mine !== generation || request !== latest) return
      set({ entries: page.entries, more: page.more })
    },

    async loadMore() {
      const mine = generation
      const last = get().entries.at(-1)
      if (last === undefined) return
      const page = await ipc().invoke('changes:list', { before: last.id, limit: CHANGES_PAGE })
      if (mine !== generation) return
      const held = new Set(get().entries.map((entry) => entry.id))
      set({
        entries: [...get().entries, ...page.entries.filter((entry) => !held.has(entry.id))],
        more: page.more
      })
    },

    undo: (id) => track(id, () => ipc().invoke('changes:undo', { id })),

    undoRun: (runId) => track(runId, () => ipc().invoke('changes:undoRun', { runId })),

    clear() {
      generation++
      set({ entries: [], more: false, pending: [] })
    },

    subscribe() {
      unsubscribe ??= ipc().on('changes:changed', () => {
        // A failed re-read keeps the list as it was; the next event reads again.
        get()
          .load()
          .catch(() => undefined)
      })
    }
  }
})

/** Empties the store and drops the subscription. For tests only. */
export function resetChangesStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useChangesStore.getState().clear()
}
