import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import { useTagStore } from './tagStore'

/**
 * The one owner of "which tags are linked to which document" in the renderer (F-4.4). Tag
 * records themselves live in the tag bank (`useTagStore`); this store holds ids only, so a
 * rename or recolor in the Tags tab shows in the chips at once. Every mutation awaits main and
 * merges the returned tag (with its fresh usage count) into the bank, never re-listing. Errors
 * propagate so the caller can show them, and a failed request leaves the store as it was.
 * The background tagging job (F-4.13) links and unlinks tags in main without a call from here;
 * main says which nodes moved (`documentTag:changed`) and the loaded ones are listed again.
 */
interface DocumentTagState {
  /** The linked tag ids per node, in `documentTag:list` order (by name); absent until loaded. */
  tagIdsByNode: Record<string, string[] | undefined>
  /**
   * Which of a node's linked tags the background job applied (F-4.13), for the "Added by AI"
   * mark; absent until the node's own `load`, since `documentTag:listAll` carries no source.
   */
  aiTagIdsByNode: Record<string, string[] | undefined>
  /** Loads a document's links; a response from a superseded load of the same node is dropped. */
  load: (nodeId: string) => Promise<void>
  /**
   * Loads every link in the project in one request (F-4.10), so the tree filter and the Tag
   * Manager's document list read the same map the chips do. A node that was loaded before and
   * has no link left comes back empty, never stale.
   */
  loadAll: () => Promise<void>
  /**
   * Links a tag to a document and moves its usage count in the bank. Linking a tag the
   * background job applied makes the link the author's (F-4.13), so its mark goes.
   */
  add: (nodeId: string, tagId: string) => Promise<void>
  /** Unlinks a tag from a document and moves its usage count in the bank. */
  remove: (nodeId: string, tagId: string) => Promise<void>
  /** Opens the one `documentTag:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
  /** Empties the store and invalidates in-flight requests (project close). */
  clear: () => void
}

/** The token of the latest `load` per node id, so a response from a superseded load is dropped. */
const loadTokens = new Map<string, number>()
/** Bumped by every clear() so a response from before it is dropped. */
let generation = 0
/** True once `loadAll` ran for this project, so a background change refreshes the whole map too. */
let allLoaded = false
/** The subscription to main's background tagging; one for the renderer, opened by `subscribe`. */
let unsubscribe: (() => void) | null = null

/** `ids` without `tagId`; the same array when it is not in it, so nothing re-renders for nothing. */
const without = (ids: string[] | undefined, tagId: string): string[] | undefined =>
  ids?.includes(tagId) ? ids.filter((id) => id !== tagId) : ids

export const useDocumentTagStore = create<DocumentTagState>((set, get) => ({
  tagIdsByNode: {},
  aiTagIdsByNode: {},

  async load(nodeId) {
    const mine = (loadTokens.get(nodeId) ?? 0) + 1
    loadTokens.set(nodeId, mine)
    const before = generation
    const tags = await ipc().invoke('documentTag:list', { nodeId })
    if (before !== generation || loadTokens.get(nodeId) !== mine) return
    const bank = useTagStore.getState()
    const aiIds: string[] = []
    for (const { source, ...tag } of tags) {
      // The bank holds tags, not links: the source of this node's link stays here.
      bank.merge(tag)
      if (source === 'ai') aiIds.push(tag.id)
    }
    set({
      tagIdsByNode: { ...get().tagIdsByNode, [nodeId]: tags.map((tag) => tag.id) },
      aiTagIdsByNode: { ...get().aiTagIdsByNode, [nodeId]: aiIds }
    })
  },

  async loadAll() {
    const before = generation
    const links = await ipc().invoke('documentTag:listAll', undefined)
    if (before !== generation) return
    allLoaded = true
    const next: Record<string, string[] | undefined> = {}
    for (const nodeId of Object.keys(get().tagIdsByNode)) next[nodeId] = []
    for (const link of links) (next[link.nodeId] ??= []).push(link.tagId)
    set({ tagIdsByNode: next })
  },

  async add(nodeId, tagId) {
    const before = generation
    const tag = await ipc().invoke('documentTag:add', { nodeId, tagId })
    if (before !== generation) return
    useTagStore.getState().merge(tag)
    const current = get().tagIdsByNode[nodeId] ?? []
    const ai = get().aiTagIdsByNode[nodeId]
    const nextAi = without(ai, tag.id)
    if (current.includes(tag.id) && nextAi === ai) return
    set({
      tagIdsByNode: current.includes(tag.id)
        ? get().tagIdsByNode
        : { ...get().tagIdsByNode, [nodeId]: [...current, tag.id] },
      aiTagIdsByNode:
        nextAi === ai ? get().aiTagIdsByNode : { ...get().aiTagIdsByNode, [nodeId]: nextAi }
    })
  },

  async remove(nodeId, tagId) {
    const before = generation
    const tag = await ipc().invoke('documentTag:remove', { nodeId, tagId })
    if (before !== generation) return
    useTagStore.getState().merge(tag)
    const current = get().tagIdsByNode[nodeId]
    const ai = get().aiTagIdsByNode[nodeId]
    const next = without(current, tagId)
    const nextAi = without(ai, tagId)
    if (next === current && nextAi === ai) return
    set({
      tagIdsByNode:
        next === current ? get().tagIdsByNode : { ...get().tagIdsByNode, [nodeId]: next },
      aiTagIdsByNode:
        nextAi === ai ? get().aiTagIdsByNode : { ...get().aiTagIdsByNode, [nodeId]: nextAi }
    })
  },

  subscribe() {
    unsubscribe ??= ipc().on('documentTag:changed', ({ nodeIds }) => {
      const state = get()
      // Only what is on screen is refetched: the named nodes whose links were loaded, and the
      // project-wide map when the tree filter or the Tag Manager asked for it. The tags the job
      // created or whose usage moved reach the bank through `tag:changed`. A refresh that fails
      // leaves the chips the author already sees; the next run asks again.
      for (const nodeId of nodeIds) {
        if (state.tagIdsByNode[nodeId] !== undefined) void state.load(nodeId).catch(() => undefined)
      }
      if (allLoaded) void state.loadAll().catch(() => undefined)
    })
  },

  clear() {
    generation++
    loadTokens.clear()
    allLoaded = false
    set({ tagIdsByNode: {}, aiTagIdsByNode: {} })
  }
}))

/** Empties the store, invalidates in-flight requests, and drops the subscription. For tests only. */
export function resetDocumentTagStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useDocumentTagStore.getState().clear()
}
