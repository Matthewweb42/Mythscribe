import { create } from 'zustand'
import type { TagMentions } from '@shared/mentions'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of the automatic mentions (F-4.12). Main owns the scan: it records where
 * each tag's name occurs in each manuscript document and says which documents changed
 * (`mention:changed`); this store holds only what has been asked for, keyed both ways — by tag
 * for the Tag Manager's detail view and by node for the tag bar — and refetches a loaded key
 * when main says its rows moved. Nothing here computes a mention of its own.
 */
interface MentionState {
  /** Every document that mentions a tag, per tag id; absent until loaded. */
  byTag: Record<string, TagMentions[] | undefined>
  /** Every tag mentioned in a document, per node id; absent until loaded. */
  byNode: Record<string, TagMentions[] | undefined>
  /** Loads one tag's mentions; a response from a superseded load of the same tag is dropped. */
  loadForTag: (tagId: string) => Promise<void>
  /** Loads one document's mentions; a response from a superseded load of the same node is dropped. */
  loadForNode: (nodeId: string) => Promise<void>
  /** Opens the one `mention:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
  /** Empties the store and invalidates in-flight requests (project close). */
  clear: () => void
}

/** The token of the latest load per tag id, so a response from a superseded load is dropped. */
const tagTokens = new Map<string, number>()
/** The same per node id. */
const nodeTokens = new Map<string, number>()
/** Bumped by every clear() so a response from before it is dropped. */
let generation = 0
/** The subscription to main's scans; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

export const useMentionStore = create<MentionState>((set, get) => ({
  byTag: {},
  byNode: {},

  async loadForTag(tagId) {
    const mine = (tagTokens.get(tagId) ?? 0) + 1
    tagTokens.set(tagId, mine)
    const before = generation
    const mentions = await ipc().invoke('mention:listForTag', { tagId })
    if (before !== generation || tagTokens.get(tagId) !== mine) return
    set({ byTag: { ...get().byTag, [tagId]: mentions } })
  },

  async loadForNode(nodeId) {
    const mine = (nodeTokens.get(nodeId) ?? 0) + 1
    nodeTokens.set(nodeId, mine)
    const before = generation
    const mentions = await ipc().invoke('mention:listForNode', { nodeId })
    if (before !== generation || nodeTokens.get(nodeId) !== mine) return
    set({ byNode: { ...get().byNode, [nodeId]: mentions } })
  },

  subscribe() {
    unsubscribe ??= ipc().on('mention:changed', ({ nodeIds }) => {
      const state = get()
      // Only what is on screen is refetched: the named documents, and every loaded tag, since a
      // scan of any document can add or drop that tag's row. A refresh that fails leaves the
      // rows the author already sees; the next scan asks again, so there is nothing to act on.
      for (const nodeId of nodeIds) {
        if (state.byNode[nodeId] !== undefined)
          void state.loadForNode(nodeId).catch(() => undefined)
      }
      for (const tagId of Object.keys(state.byTag)) {
        void state.loadForTag(tagId).catch(() => undefined)
      }
    })
  },

  clear() {
    generation++
    tagTokens.clear()
    nodeTokens.clear()
    set({ byTag: {}, byNode: {} })
  }
}))

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetMentionStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useMentionStore.getState().clear()
}
