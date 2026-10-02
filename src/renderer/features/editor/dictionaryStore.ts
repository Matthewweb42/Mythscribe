import { create } from 'zustand'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's spelling dictionary in the renderer (F-3.11): the words the
 * spellchecker accepts in this project, and the words the author said are not a misspelled story
 * name (F-3.14). `add`, `remove`, and `dismissName` await main, which stores the word and
 * syncs the spellchecker, and keep the list it answers; nothing is debounced and nothing is
 * re-listed. A failed write toasts and leaves the list as it was. Loaded with the tree on project
 * open and cleared on close (`App.tsx`).
 */
interface DictionaryState {
  /** The accepted words, sorted as main stores them; null until `load` resolves. */
  words: string[] | null
  /** The words dismissed with `Not a name` (F-3.14), lower-cased; null until `load` resolves. */
  notNames: string[] | null
  load: () => Promise<void>
  /** Adds a word; answers whether main took it (false after a toast). */
  add: (word: string) => Promise<boolean>
  /** Removes a word; answers whether main took it (false after a toast). */
  remove: (word: string) => Promise<boolean>
  /** Remembers a word as not a misspelled name (F-3.14); answers whether main took it (false after a toast). */
  dismissName: (word: string) => Promise<boolean>
  /** Empties the store and drops any answer still on its way. */
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0

export const useDictionaryStore = create<DictionaryState>((set) => ({
  words: null,
  notNames: null,

  async load() {
    const mine = ++generation
    const dictionary = await ipc().invoke('dictionary:get', undefined)
    if (mine !== generation) return
    set({ words: dictionary.words, notNames: dictionary.notNames })
  },

  async add(word) {
    const mine = generation
    try {
      const dictionary = await ipc().invoke('dictionary:add', { word })
      if (mine === generation) set({ words: dictionary.words, notNames: dictionary.notNames })
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    }
  },

  async remove(word) {
    const mine = generation
    try {
      const dictionary = await ipc().invoke('dictionary:remove', { word })
      if (mine === generation) set({ words: dictionary.words, notNames: dictionary.notNames })
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    }
  },

  async dismissName(word) {
    const mine = generation
    try {
      const dictionary = await ipc().invoke('dictionary:notName', { word })
      if (mine === generation) set({ words: dictionary.words, notNames: dictionary.notNames })
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    }
  },

  clear() {
    generation++
    set({ words: null, notNames: null })
  }
}))

/** Empties the store and drops any answer in flight. For tests only. */
export function resetDictionaryStore(): void {
  useDictionaryStore.getState().clear()
}
