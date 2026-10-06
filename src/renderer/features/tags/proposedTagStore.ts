import { create } from 'zustand'
import type { Tag } from '@shared/ipc/contract'
import type { ProposedTag } from '@shared/proposedTags'
import { toTagName } from '@shared/tags'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentTagStore } from './documentTagStore'
import { useTagStore } from './tagStore'

/**
 * The renderer's view of the proposed tags (F-4.12b). Main owns the list — it reads the saved
 * manuscript, the tag bank, and the dismissals, and pushes a list that differs from the last one
 * (`tag:proposedChanged`) — so this store only holds what it was told and asks once when the
 * project opens. Nothing here proposes or creates anything of its own: accepting a proposal is
 * an ordinary `tag:create` (the author's explicit act), and main drops the accepted name from
 * the next list because it is a tag now. The same store carries the dismissed names, so the tag
 * bar's offer of a node's title as a tag (F-2.8) honours the same refusals, and that offer's accept.
 */
interface ProposedTagState {
  /** What main last said; empty until the first load, and for a manuscript with nothing to propose. */
  proposals: ProposedTag[]
  /** The names the author dismissed for the project, kebab-cased (F-2.8 reads them); empty until the first load. */
  dismissed: string[]
  /** Asks main for the list and the dismissed names; a response from before a `clear` is dropped. */
  load: () => Promise<void>
  /** Opens the one `tag:proposedChanged` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
  /** Creates the proposed name as a character tag (F-4.1) and resolves with the stored row. */
  accept: (name: string) => Promise<Tag>
  /**
   * F-2.8: creates a node title's tag as a custom tag and links it to the node, so it shows in
   * the tag bar and is usable inline at once; resolves with the stored row.
   */
  acceptTitle: (nodeId: string, name: string) => Promise<Tag>
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
  dismissed: [],

  async load() {
    const mine = generation
    const [proposals, dismissed] = await Promise.all([
      ipc().invoke('tag:proposed', undefined),
      ipc().invoke('tag:dismissedNames', undefined)
    ])
    if (mine === generation) set({ proposals, dismissed })
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

  /** A failed create or link propagates; a tag created before a failed link stays in the bank. */
  async acceptTitle(nodeId, name) {
    const tag = await useTagStore.getState().create({ name, category: 'custom' })
    await useDocumentTagStore.getState().add(nodeId, tag.id)
    return tag
  },

  /** Main kebab-cases and stores the name; the local list takes it the same way, once. */
  async dismiss(name) {
    const mine = generation
    const proposals = await ipc().invoke('tag:dismissProposed', { name })
    if (mine !== generation) return
    const stored = toTagName(name)
    set((s) => ({
      proposals,
      dismissed: s.dismissed.includes(stored) ? s.dismissed : [...s.dismissed, stored]
    }))
  },

  clear() {
    generation++
    set({ proposals: [], dismissed: [] })
  }
}))

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetProposedTagStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useProposedTagStore.getState().clear()
}
