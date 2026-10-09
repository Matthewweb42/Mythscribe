import { create } from 'zustand'
import type { ThreadView } from '@shared/threads'
import { ipc } from '@renderer/lib/ipc'

/**
 * The Threads section (F-9.14), renderer side: the threads as `thread:list` answers them (records
 * in the Threads category, their events in reading order, the derived status). Main derives
 * everything; the store only holds the last answer. `fact:changed` and `entity:changed` re-read it
 * once it has been loaded (a reading added an event or made a thread record).
 */
interface ThreadState {
  threads: ThreadView[]
  loaded: boolean
  load: () => Promise<void>
  clear: () => void
  /** Opens the subscriptions (idempotent); call it where the project opens. */
  subscribe: () => void
}

let generation = 0
let latest = 0
let unsubscribe: (() => void) | null = null

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  loaded: false,

  async load() {
    const mine = generation
    const request = ++latest
    const threads = await ipc().invoke('thread:list', undefined)
    if (mine !== generation || request !== latest) return
    set({ threads, loaded: true })
  },

  clear() {
    generation++
    set({ threads: [], loaded: false })
  },

  subscribe() {
    if (unsubscribe !== null) return
    const reload = (): void => {
      if (!get().loaded) return
      // A failed re-read keeps the list as it was; the next event reads again.
      get()
        .load()
        .catch(() => undefined)
    }
    const offFacts = ipc().on('fact:changed', reload)
    const offEntities = ipc().on('entity:changed', reload)
    unsubscribe = () => {
      offFacts()
      offEntities()
    }
  }
}))

/** Empties the store and drops the subscriptions. For tests only. */
export function resetThreadStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useThreadStore.getState().clear()
}
