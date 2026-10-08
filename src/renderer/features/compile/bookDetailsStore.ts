import { create } from 'zustand'
import type { BookDetails } from '@shared/bookDetails'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's Book details in the renderer (Compile v2, CV3): loaded once
 * per project (`load`), replaced on Save in the Book details page, and read by the compile
 * window's preview. The cover changes through its own channels, which answer the stored details.
 * Cleared when the project closes (`App.tsx`).
 */
interface BookDetailsState {
  details: BookDetails | null
  /** Loads the stored details unless they are already here (`force` reloads). */
  load: (force?: boolean) => Promise<BookDetails>
  /** Stores `details` (the cover is kept as stored) and answers what was stored. */
  save: (details: BookDetails) => Promise<BookDetails>
  /** Asks for an image and makes it the cover; null when the file dialog was cancelled. */
  setCover: () => Promise<BookDetails | null>
  removeCover: () => Promise<BookDetails>
  clear: () => void
}

/** Bumped by every clear, so an answer for a closed project is dropped. */
let generation = 0

export const useBookDetailsStore = create<BookDetailsState>((set, get) => ({
  details: null,

  async load(force = false) {
    const current = get().details
    if (current !== null && !force) return current
    const mine = generation
    const details = await ipc().invoke('bookDetails:get', undefined)
    if (mine === generation) set({ details })
    return details
  },

  async save(details) {
    const mine = generation
    const stored = await ipc().invoke('bookDetails:set', details)
    if (mine === generation) set({ details: stored })
    return stored
  },

  async setCover() {
    const mine = generation
    const stored = await ipc().invoke('bookDetails:setCover', undefined)
    if (stored !== null && mine === generation) set({ details: stored })
    return stored
  },

  async removeCover() {
    const mine = generation
    const stored = await ipc().invoke('bookDetails:removeCover', undefined)
    if (mine === generation) set({ details: stored })
    return stored
  },

  clear() {
    generation++
    set({ details: null })
  }
}))
