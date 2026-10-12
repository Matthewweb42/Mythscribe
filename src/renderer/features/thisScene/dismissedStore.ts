import { create } from 'zustand'
import type { Dismissed } from '@shared/memory/dismissed'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one Dismissed list in the renderer (F-16.10, answer 22; story memory v2): the one owner of
 * the rows the panel's footer counts (**Dismissed (n)**) and the Dismissed dialog lists, newest
 * first. Loaded on a v2 open. A tombstone the panel writes itself (*Not a mention*, *Not a name*,
 * a nickname's *No*) is added from main's answer; the ones a record change writes (a nickname
 * removed, a split, a merge, a rename) are read again on a roster `record:changed`. *Undo* deletes
 * the row in main, so the thing may come back, and drops it here.
 */
interface DismissedState {
  /** Newest first. */
  items: Dismissed[]
  loaded: boolean
  /** Whether the Dismissed dialog is open. */
  open: boolean
  load: () => Promise<void>
  /** A tombstone main just wrote (an answer the renderer sent): it goes first, once. */
  add: (row: Dismissed) => void
  /** Undo on a row: the tombstone goes. Answers whether it went. */
  undo: (id: string) => Promise<boolean>
  setOpen: (open: boolean) => void
  /** Opens the `record:changed` subscription (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null

export const useDismissedStore = create<DismissedState>((set, get) => ({
  items: [],
  loaded: false,
  open: false,

  async load() {
    const mine = generation
    const list = await ipc().invoke('dismissed:list', undefined)
    if (mine !== generation) return
    set({ items: list.items, loaded: true })
  },

  add(row) {
    const items = get().items.filter((each) => each.id !== row.id)
    set({ items: [row, ...items] })
  },

  async undo(id) {
    const mine = generation
    try {
      await ipc().invoke('dismissed:undo', { id })
    } catch (err) {
      toast.error(describeError(err))
      // A row someone else undid (or a record deleted with it) is gone either way.
      if (mine === generation)
        await get()
          .load()
          .catch(() => undefined)
      return false
    }
    if (mine === generation) set({ items: get().items.filter((each) => each.id !== id) })
    return true
  },

  setOpen(open) {
    if (get().open !== open) set({ open })
  },

  subscribe() {
    unsubscribe ??= ipc().on('record:changed', ({ roster }) => {
      if (!roster) return
      get()
        .load()
        .catch((err: unknown) => toast.error(describeError(err)))
    })
  },

  clear() {
    generation++
    set({ items: [], loaded: false, open: false })
  }
}))

/** Closes the subscription and empties the store. For tests and project close. */
export function resetDismissedStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useDismissedStore.getState().clear()
}
