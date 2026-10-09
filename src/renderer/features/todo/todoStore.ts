import { create } from 'zustand'
import { continuityFindingIdOf, todoCounts, type TodoCounts, type TodoItem } from '@shared/todo'
import { ipc } from '@renderer/lib/ipc'
import { goToTodo } from './todoJump'

/** The last Done or Dismiss, for its Undo; a contradiction's dismissal cannot be undone. */
export interface TodoSettled {
  id: string
  subject: string
  status: 'done' | 'dismissed'
  reopenable: boolean
}

/** An item settled while going through the list, kept on the deck as settled. */
export interface TodoDecided {
  item: TodoItem
  status: 'done' | 'dismissed'
}

/** Going through the list one by one: where the author is, what waits for later, what was settled. */
export interface TodoReview {
  currentId: string | null
  skipped: string[]
  decided: TodoDecided[]
}

/** The editable line of a card: what Add writes to the item's target. */
export interface TodoComposer {
  id: string
  text: string
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
  /** Go through one by one (the review deck above the editor); null when not going through. */
  review: TodoReview | null
  composer: TodoComposer | null
  load: () => Promise<void>
  settle: (id: string, status: 'done' | 'dismissed') => Promise<void>
  /** Undo of the last settle. */
  undo: () => Promise<void>
  /** Forgets the last settle (its Undo offer closes). */
  forgetSettled: () => void
  /** Starts going through the list at `id` (the first item when null) and jumps to its passage. */
  startReview: (id?: string | null) => void
  endReview: () => void
  /** The deck shows `id`: the editor jumps to its passage. */
  reviewAt: (id: string | null) => void
  /** Later: the item stays open, and the deck moves on. */
  skipInReview: (ids: readonly string[]) => void
  openComposer: (id: string, text: string) => void
  setComposerText: (text: string) => void
  closeComposer: () => void
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
    review: null,
    composer: null,

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
        const review = get().review
        set({
          items,
          counts: todoCounts(items),
          review:
            review === null || item === undefined
              ? review
              : { ...review, decided: [...review.decided, { item, status }] },
          composer: get().composer?.id === id ? null : get().composer,
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

    startReview(id = null) {
      const item =
        (id === null ? undefined : get().items.find((each) => each.id === id)) ?? get().items[0]
      set({
        review: { currentId: item?.id ?? null, skipped: [], decided: [] },
        composer: null
      })
      if (item !== undefined) goToTodo(item)
    },

    endReview() {
      set({ review: null, composer: null })
    },

    reviewAt(id) {
      const review = get().review
      if (review === null || review.currentId === id) return
      set({
        review: { ...review, currentId: id },
        composer: get().composer?.id === id ? get().composer : null
      })
      const item = get().items.find((each) => each.id === id)
      if (item !== undefined) goToTodo(item)
    },

    skipInReview(ids) {
      const review = get().review
      if (review === null) return
      set({ review: { ...review, skipped: [...new Set([...review.skipped, ...ids])] } })
    },

    openComposer(id, text) {
      set({ composer: { id, text } })
    },

    setComposerText(text) {
      const composer = get().composer
      if (composer !== null) set({ composer: { ...composer, text } })
    },

    closeComposer() {
      set({ composer: null })
    },

    clear() {
      generation++
      set({
        items: [],
        counts: EMPTY_COUNTS,
        loaded: false,
        pending: [],
        settled: null,
        review: null,
        composer: null
      })
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
