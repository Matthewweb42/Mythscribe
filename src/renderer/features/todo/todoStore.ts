import { create } from 'zustand'
import { continuityFindingIdOf, todoCounts, type TodoCounts, type TodoItem } from '@shared/todo'
import { ipc } from '@renderer/lib/ipc'

/** The last Done or Dismiss, for its Undo; a contradiction's dismissal cannot be undone. */
export interface TodoSettled {
  id: string
  subject: string
  status: 'done' | 'dismissed'
  reopenable: boolean
}

/**
 * The To do list (F-9.16): the renderer owner of the open items main lists (`todo:list`). Main's
 * `todo:changed` re-reads them. Settling an item drops it at once and remembers it for Undo.
 */
interface TodoState {
  items: TodoItem[]
  counts: TodoCounts
  loaded: boolean
  /** Ids being settled or reopened, for the buttons. */
  pending: string[]
  settled: TodoSettled | null
  load: () => Promise<void>
  settle: (id: string, status: 'done' | 'dismissed') => Promise<void>
  /** Undo of the last settle. */
  undo: () => Promise<void>
  /** Forgets the last settle (its Undo offer closes). */
  forgetSettled: () => void
  clear: () => void
  /** Opens the one `todo:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

const EMPTY_COUNTS: TodoCounts = { undefined: 0, contradiction: 0, looseEnd: 0, gap: 0 }

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
let latest = 0
let unsubscribe: (() => void) | null = null

export const useTodoStore = create<TodoState>((set, get) => {
  const track = async (id: string, task: () => Promise<void>): Promise<void> => {
    const mine = generation
    set({ pending: [...get().pending, id] })
    try {
      await task()
    } finally {
      if (mine === generation) set({ pending: get().pending.filter((each) => each !== id) })
    }
  }

  return {
    items: [],
    counts: EMPTY_COUNTS,
    loaded: false,
    pending: [],
    settled: null,

    async load() {
      const mine = generation
      const request = ++latest
      const view = await ipc().invoke('todo:list', undefined)
      if (mine !== generation || request !== latest) return
      set({ items: view.items, counts: view.counts, loaded: true })
    },

    settle: (id, status) =>
      track(id, async () => {
        const mine = generation
        const item = get().items.find((each) => each.id === id)
        await ipc().invoke('todo:settle', { id, status })
        if (mine !== generation) return
        const items = get().items.filter((each) => each.id !== id)
        set({
          items,
          counts: todoCounts(items),
          settled: {
            id,
            subject: item?.subject ?? '',
            status,
            reopenable: continuityFindingIdOf(id) === null
          }
        })
      }),

    async undo() {
      const settled = get().settled
      if (!settled?.reopenable) return
      await track(settled.id, async () => {
        const mine = generation
        await ipc().invoke('todo:reopen', { id: settled.id })
        if (mine !== generation) return
        set({ settled: null })
        await get().load()
      })
    },

    forgetSettled() {
      set({ settled: null })
    },

    clear() {
      generation++
      set({ items: [], counts: EMPTY_COUNTS, loaded: false, pending: [], settled: null })
    },

    subscribe() {
      unsubscribe ??= ipc().on('todo:changed', () => {
        // A failed re-read keeps the list as it was; the next event reads again.
        get()
          .load()
          .catch(() => undefined)
      })
    }
  }
})

/** Empties the store and drops the subscription. For tests only. */
export function resetTodoStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useTodoStore.getState().clear()
}
