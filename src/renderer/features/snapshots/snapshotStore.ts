import { create } from 'zustand'
import type {
  SnapshotInfo,
  SnapshotList,
  SnapshotRestore,
  TakeSnapshot,
  UpdateSnapshot
} from '@shared/snapshots'
import { refreshRewrittenDocuments } from '@renderer/features/editor/rewrittenDocuments'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the open project's snapshots in the renderer (F-8.6): main's list (newest
 * first) and the actions on it. Every action awaits main and keeps the list it answers; nothing
 * is optimistic. Pending saves are flushed before each one (a snapshot must hold what is on
 * screen, and a restore rewrites live text that an editor's next autosave would otherwise put
 * back); a failed flush aborts the action. A restore refreshes the documents main rewrote through
 * the same path as drafts, not counted as words written. A failure toasts its cause and leaves
 * the list as it was. Loaded when a project opens and cleared when it closes (`App.tsx`).
 */
interface SnapshotState {
  /** Newest first; null until `load` resolves. */
  snapshots: SnapshotInfo[] | null
  /** True while a mutating action is in flight; the dialog disables its actions meanwhile. */
  busy: boolean
  load: () => Promise<void>
  /** Takes a snapshot; answers whether main did it (false after a toast). */
  take: (input: TakeSnapshot) => Promise<boolean>
  /** Renames, edits the note, or flags or unflags the milestone; answers whether main did it. */
  update: (input: UpdateSnapshot) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  /**
   * Takes documents back to snapshot `id`'s text: `nodeIds`, or every document it holds when
   * omitted. Main keeps the text it overwrites as an automatic snapshot first.
   */
  restore: (id: string, nodeIds?: string[]) => Promise<boolean>
  /** Empties the store and drops any answer still on its way. */
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0

export const useSnapshotStore = create<SnapshotState>((set, get) => {
  /**
   * Runs one mutating action: flushes pending saves, asks main, keeps its list, and for a restore
   * refreshes the documents main rewrote. Answers false after a toast.
   */
  const mutate = async (
    ask: () => Promise<SnapshotList | SnapshotRestore>,
    done?: () => string
  ): Promise<boolean> => {
    if (get().busy) return false
    const mine = generation
    set({ busy: true })
    try {
      await flushPendingSaves()
      const answer = await ask()
      if (mine !== generation) return false // the project closed meanwhile
      if (Array.isArray(answer)) {
        set({ snapshots: answer })
      } else {
        set({ snapshots: answer.snapshots })
        await refreshRewrittenDocuments(answer.changed, { countsAsWriting: false })
      }
      if (done) toast.success(done())
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  const nameOf = (id: string): string =>
    get().snapshots?.find((s) => s.id === id)?.name ?? 'snapshot'

  return {
    snapshots: null,
    busy: false,

    async load() {
      const mine = ++generation
      const list = await ipc().invoke('snapshots:list', undefined)
      if (mine !== generation) return
      set({ snapshots: list })
    },

    take(input) {
      return mutate(
        () => ipc().invoke('snapshots:take', input),
        () => `Took "${input.name.trim()}".`
      )
    },

    update(input) {
      return mutate(() => ipc().invoke('snapshots:update', input))
    },

    remove(id) {
      const name = nameOf(id)
      return mutate(
        () => ipc().invoke('snapshots:delete', { id }),
        () => `Deleted "${name}".`
      )
    },

    restore(id, nodeIds) {
      const name = nameOf(id)
      return mutate(
        () => ipc().invoke('snapshots:restore', nodeIds ? { id, nodeIds } : { id }),
        () =>
          nodeIds?.length === 1 ? `Restored the document from "${name}".` : `Restored "${name}".`
      )
    },

    clear() {
      generation++
      set({ snapshots: null, busy: false })
    }
  }
})

/** Empties the store and drops any answer in flight. For tests only. */
export function resetSnapshotStore(): void {
  useSnapshotStore.getState().clear()
}
