import { create } from 'zustand'
import type { Tag } from '@shared/ipc/contract'
import type { ProposedTag } from '@shared/proposedTags'
import { ipc } from '@renderer/lib/ipc'
import { useTagStore } from './tagStore'

/**
 * The renderer's view of the proposed tags (F-4.12b). Main owns the list — it reads the saved
 * manuscript, the tag bank, and the dismissals, and pushes a list that differs from the last one
 * (`tag:proposedChanged`) — so this store only holds what it was told and asks once when the
 * project opens. Nothing here proposes or creates anything of its own: accepting a proposal is
 * an ordinary `tag:create` (the author's explicit act), and main drops the accepted name from
 * the next list because it is a tag now.
 */
interface ProposedTagState {
  /** What main last said; empty until the first load, and for a manuscript with nothing to propose. */
  proposals: ProposedTag[]
  /** Asks main for the list; a response from before a `clear` is dropped. */
  load: () => Promise<void>
  /** Opens the one `tag:proposedChanged` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
  /** Creates the proposed name as a character tag (F-4.1) and resolves with the stored row. */
  accept: (name: string) => Promise<Tag>
  /** Dismisses the name for the project; main answers with the list without it. */
  dismiss: (name: string) => Promise<void>
  /** Empties the store and invalidates in-flight requests (project close). */
  clear: () => void
}

/** Bumped by every clear() so a response from before it is dropped. */
let generation = 0
/** The subscription to main's list; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useProposedTagStore = create<ProposedTagState>((set) => ({
  proposals: [],

  async load() {
    const mine = generation
    const proposals = await ipc().invoke('tag:proposed', undefined)
    if (mine === generation) set({ proposals })
  },

  subscribe() {
    unsubscribe ??= ipc().on('tag:proposedChanged', (proposals) => {
      set({ proposals })
    })
  },

  /**
   * A proposal is only ever a character name: the bar proposes people, and a tag of another
   * category is made in the Tag Manager. Main's `tag:create` publishes the list without it, so
   * nothing is dropped here; a failed create propagates and the row stays where the author saw it.
   */
  accept(name) {
    return useTagStore.getState().create({ name, category: 'character' })
  },

  async dismiss(name) {
    const mine = generation
    const proposals = await ipc().invoke('tag:dismissProposed', { name })
    if (mine === generation) set({ proposals })
  },

  clear() {
    generation++
    set({ proposals: [] })
  }
}))

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetProposedTagStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useProposedTagStore.getState().clear()
}
