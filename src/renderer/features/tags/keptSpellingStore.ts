import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'

/**
 * The spellings the author kept (F-4.14, "Not a typo" on a likely misspelling of a story name),
 * as main's `aliasKey` keys. Main owns the list; it is read once per project, and only when the
 * tags column first has a misspelling to offer, so a book without any never asks.
 */
interface KeptSpellingState {
  keys: string[]
  /** True once the project's list has been read. */
  loaded: boolean
  /** Reads the list once per project; a second call while loaded does nothing. */
  ensureLoaded: () => Promise<void>
  /** Keeps a spelling; main answers with the whole list. */
  keep: (text: string) => Promise<void>
  /** Empties the store and invalidates in-flight requests (project close). */
  clear: () => void
}

/** Bumped by every clear() so a response from before it is dropped. */
let generation = 0
let inflight: Promise<void> | null = null

export const useKeptSpellingStore = create<KeptSpellingState>((set, get) => ({
  keys: [],
  loaded: false,

  ensureLoaded() {
    if (get().loaded) return Promise.resolve()
    if (inflight !== null) return inflight
    const mine = generation
    inflight = ipc()
      .invoke('tag:keptSpellings', undefined)
      .then((keys) => {
        if (mine === generation) set({ keys, loaded: true })
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  async keep(text) {
    const mine = generation
    const keys = await ipc().invoke('tag:keepSpelling', { text })
    if (mine === generation) set({ keys, loaded: true })
  },

  clear() {
    generation++
    inflight = null
    set({ keys: [], loaded: false })
  }
}))

/** Empties the store and invalidates in-flight requests. For tests. */
export function resetKeptSpellingStore(): void {
  useKeptSpellingStore.getState().clear()
}
