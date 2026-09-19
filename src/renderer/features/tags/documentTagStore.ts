import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import { useTagStore } from './tagStore'

/**
 * The one owner of "which tags are linked to which document" in the renderer (F-4.4). Tag
 * records themselves live in the tag bank (`useTagStore`); this store holds ids only, so a
 * rename or recolor in the Tags tab shows in the chips at once. Every mutation awaits main and
 * merges the returned tag (with its fresh usage count) into the bank, never re-listing. Errors
 * propagate so the caller can show them, and a failed request leaves the store as it was.
 */
interface DocumentTagState {
  /** The linked tag ids per node, in `documentTag:list` order (by name); absent until loaded. */
  tagIdsByNode: Record<string, string[] | undefined>
  /** Loads a document's links; a response from a superseded load of the same node is dropped. */
  load: (nodeId: string) => Promise<void>
  /**
   * Loads every link in the project in one request (F-4.10), so the tree filter and the Tag
   * Manager's document list read the same map the chips do. A node that was loaded before and
   * has no link left comes back empty, never stale.
   */
  loadAll: () => Promise<void>
  /** Links a tag to a document and moves its usage count in the bank. */
  add: (nodeId: string, tagId: string) => Promise<void>
  /** Unlinks a tag from a document and moves its usage count in the bank. */
  remove: (nodeId: string, tagId: string) => Promise<void>
  /** Empties the store and invalidates in-flight requests (project close). */
  clear: () => void
}

/** The token of the latest `load` per node id, so a response from a superseded load is dropped. */
const loadTokens = new Map<string, number>()
/** Bumped by every clear() so a response from before it is dropped. */
let generation = 0

export const useDocumentTagStore = create<DocumentTagState>((set, get) => ({
  tagIdsByNode: {},

  async load(nodeId) {
    const mine = (loadTokens.get(nodeId) ?? 0) + 1
    loadTokens.set(nodeId, mine)
    const before = generation
    const tags = await ipc().invoke('documentTag:list', { nodeId })
    if (before !== generation || loadTokens.get(nodeId) !== mine) return
    const bank = useTagStore.getState()
    for (const tag of tags) bank.merge(tag)
    set({ tagIdsByNode: { ...get().tagIdsByNode, [nodeId]: tags.map((tag) => tag.id) } })
  },

  async loadAll() {
    const before = generation
    const links = await ipc().invoke('documentTag:listAll', undefined)
    if (before !== generation) return
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
    if (current.includes(tag.id)) return
    set({ tagIdsByNode: { ...get().tagIdsByNode, [nodeId]: [...current, tag.id] } })
  },

  async remove(nodeId, tagId) {
    const before = generation
    const tag = await ipc().invoke('documentTag:remove', { nodeId, tagId })
    if (before !== generation) return
    useTagStore.getState().merge(tag)
    const current = get().tagIdsByNode[nodeId]
    if (!current?.includes(tagId)) return
    set({
      tagIdsByNode: { ...get().tagIdsByNode, [nodeId]: current.filter((id) => id !== tagId) }
    })
  },

  clear() {
    generation++
    loadTokens.clear()
    set({ tagIdsByNode: {} })
  }
}))

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetDocumentTagStore(): void {
  useDocumentTagStore.getState().clear()
}
