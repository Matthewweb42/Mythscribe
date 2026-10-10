import { create } from 'zustand'
import {
  continuityFindingIdOf,
  todoCounts,
  type TodoCheck,
  type TodoCheckResult,
  type TodoCounts,
  type TodoItem
} from '@shared/todo'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { goToTodo } from './todoJump'

/** How a Check the whole book ended, in the words the drop notification shows. */
export interface TodoCheckOutcome {
  status: 'done' | 'failed' | 'cancelled'
  message: string
}

/** What a check's answer means for the author, in the drop notification's words. */
export function checkOutcome(result: TodoCheckResult): TodoCheckOutcome {
  if (!result.ok) {
    return result.code === 'CANCELLED'
      ? { status: 'cancelled', message: '' }
      : { status: 'failed', message: `${result.message} ${result.nextStep}`.trim() }
  }
  if (!result.requested) {
    return {
      status: 'done',
      message: result.unchanged
        ? 'Nothing changed since the last check.'
        : 'No scene has a card yet: the check reads the scene cards.'
    }
  }
  if (result.added === 0 && result.resolved === 0) {
    return { status: 'done', message: 'The check found nothing new.' }
  }
  const parts = [
    result.added > 0 ? `${result.added} new ${result.added === 1 ? 'item' : 'items'}` : '',
    result.resolved > 0 ? `${result.resolved} answered` : ''
  ].filter((part) => part !== '')
  return { status: 'done', message: `To do: ${parts.join(', ')}.` }
}

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
  /** The AI check's header (F-9.16): may it run, when it last ran, what a run would cost. */
  check: TodoCheck
  /** True while Check the whole book runs. */
  checking: boolean
  /**
   * How the last Check the whole book ended, set as `checking` goes false (F-7.12: the drop
   * notification says it; a stopped check is `cancelled`, which says nothing). Null before any.
   */
  checkResult: TodoCheckOutcome | null
  /** Items whose suggestions are being asked for. */
  suggesting: string[]
  /** Why an item's suggestions could not be had, by item id (shown on its card). */
  suggestErrors: Record<string, string>
  load: () => Promise<void>
  /** Check the whole book (only ever on the author's click); `checkResult` says what it found (F-7.12 drops it down). */
  runCheck: () => Promise<void>
  /**
   * Asks for an item's suggestions once, when its card is shown (and for the next card, ahead):
   * nothing when AI may not run, the item already has them, or a request is in flight.
   */
  suggest: (id: string) => Promise<void>
  settle: (id: string, status: 'done' | 'dismissed') => Promise<void>
  /** Undo of the last settle. */
  undo: () => Promise<void>
  /**
   * F-5.25 (agent.v8): reopens settled items (the chat's Undo of a settle); a contradiction,
   * settled in the consistency checker, stays settled. Reads the list again.
   */
  reopen: (ids: readonly string[]) => Promise<void>
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
const IDLE_CHECK: TodoCheck = {
  allowed: false,
  lastAt: null,
  lastCostUsd: null,
  estimateUsd: null,
  fresh: false
}

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
let latest = 0
let unsubscribe: (() => void) | null = null
let counter = 0
const nextRequestId = (kind: string): string =>
  `todo-${kind}-${Date.now().toString(36)}-${++counter}`

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
    check: IDLE_CHECK,
    checking: false,
    checkResult: null,
    suggesting: [],
    suggestErrors: {},

    async load() {
      const mine = generation
      const request = ++latest
      const view = await ipc().invoke('todo:list', undefined)
      if (mine !== generation || request !== latest) return
      set({ items: view.items, counts: view.counts, check: view.check, loaded: true })
    },

    async runCheck() {
      if (get().checking) return
      const mine = generation
      set({ checking: true, checkResult: null })
      const requestId = nextRequestId('check')
      // F-7.12: the outcome goes out with `checking: false` in one write, so the activity watch
      // reads it the moment the job ends and drops it down from the top (no toast of its own).
      let checkResult: TodoCheckOutcome
      try {
        const result = await useAiActivityStore
          .getState()
          .track('todo', requestId, ipc().invoke('todo:check', { requestId }))
        if (mine !== generation) return
        checkResult = checkOutcome(result)
      } catch (err) {
        if (mine !== generation) return
        checkResult = { status: 'failed', message: describeError(err) }
      }
      set({ checking: false, checkResult })
    },

    async suggest(id) {
      const item = get().items.find((each) => each.id === id)
      if (
        item === undefined ||
        item.suggested ||
        !get().check.allowed ||
        get().suggesting.includes(id) ||
        get().suggestErrors[id] !== undefined
      ) {
        return
      }
      const mine = generation
      set({ suggesting: [...get().suggesting, id] })
      const requestId = nextRequestId('suggest')
      try {
        const result = await useAiActivityStore
          .getState()
          .track('todo', requestId, ipc().invoke('todo:suggest', { id, requestId }))
        if (mine !== generation) return
        if (!result.ok) {
          if (result.code !== 'CANCELLED') {
            set({
              suggestErrors: {
                ...get().suggestErrors,
                [id]: `${result.message} ${result.nextStep}`.trim()
              }
            })
          }
          return
        }
        set({
          items: get().items.map((each) =>
            each.id === id ? { ...each, suggestions: result.suggestions, suggested: true } : each
          )
        })
      } catch (err) {
        if (mine === generation) {
          set({ suggestErrors: { ...get().suggestErrors, [id]: describeError(err) } })
        }
      } finally {
        if (mine === generation) set({ suggesting: get().suggesting.filter((each) => each !== id) })
      }
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

    async reopen(ids) {
      const mine = generation
      for (const id of ids) {
        if (continuityFindingIdOf(id) !== null) continue
        await track(id, async () => {
          await ipc().invoke('todo:reopen', { id })
        })
        if (mine !== generation) return
      }
      const settled = get().settled
      if (settled !== null && ids.includes(settled.id)) set({ settled: null })
      await get().load()
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
      if (item !== undefined) {
        goToTodo(item)
        prefetch(item.id)
      }
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
      if (item !== undefined) {
        goToTodo(item)
        prefetch(item.id)
      }
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
        composer: null,
        check: IDLE_CHECK,
        checking: false,
        checkResult: null,
        suggesting: [],
        suggestErrors: {}
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

/**
 * The card on show gets its suggestions, and the next open item in the list gets them ahead, so
 * the author does not wait on the next card. A failure shows on the card; nothing is retried.
 */
function prefetch(id: string): void {
  const { items, suggest } = useTodoStore.getState()
  const at = items.findIndex((each) => each.id === id)
  const next = at === -1 ? undefined : items[at + 1]
  const ask = (target: string): void => {
    suggest(target).catch(() => undefined)
  }
  ask(id)
  if (next !== undefined) ask(next.id)
}

/** Empties the store and drops the subscription. For tests only. */
export function resetTodoStore(): void {
  unsubscribe?.()
  unsubscribe = null
  counter = 0
  useTodoStore.getState().clear()
}
