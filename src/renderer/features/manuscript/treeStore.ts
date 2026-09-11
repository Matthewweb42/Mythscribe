import { create } from 'zustand'
import type { TreeNode } from '@shared/ipc/contract'
import type { HierarchyLevel, NodeKind, SectionType } from '@shared/labels'
import { ipc } from '@renderer/lib/ipc'
import { resolveCreateTarget, resolveGenericTarget, type CreateTarget } from './placement'

/** Derived, normalized view of the document tree (F-2.1). Rebuilt in full by `load`. */
export interface TreeIndex {
  byId: Record<string, TreeNode>
  /** Child ids per parent id, in position order. */
  childrenOf: Record<string, string[]>
  /** Section root ids in position order. */
  rootIds: string[]
  /** The owning section of every node, including the section roots themselves. */
  sectionOf: Record<string, SectionType>
  /** Documents: own count. Folders and sections: sum of descendant documents. */
  wordCountRollup: Record<string, number>
}

interface TreeState extends TreeIndex {
  selectedId: string | null
  collapsed: Record<string, boolean>
  loaded: boolean
  /** The node whose title is being edited inline (F-2.2), if any. */
  renamingId: string | null
  /** True while a create or rename request is in flight; the create buttons disable on it. */
  busy: boolean
  load: () => Promise<void>
  /** Selects a document or folder. Section roots are not selectable. */
  select: (id: string | null) => void
  /** Collapses or expands a folder or section. Documents are ignored. */
  toggle: (id: string) => void
  clear: () => void
  startRename: (id: string) => void
  endRename: () => void
  /**
   * Creates a part/chapter/scene relative to `targetId` (default: the selection) per
   * `resolveCreateTarget`, then selects the new node and opens inline rename. No-op when there is
   * no valid placement. Errors propagate so the caller can show them.
   */
  createLevel: (level: HierarchyLevel, targetId?: string) => Promise<void>
  /** Creates a generic document or folder relative to `targetId` per `resolveGenericTarget`. */
  createGeneric: (kind: NodeKind, targetId: string) => Promise<void>
  /** Renames a node and ends its inline rename. Errors propagate. */
  rename: (id: string, title: string) => Promise<void>
}

const byPosition = (a: TreeNode, b: TreeNode): number => a.position - b.position

/** Builds the derived maps from a flat node list. Pure, so it is testable without the store. */
export function buildIndex(nodes: TreeNode[]): TreeIndex {
  const byId: Record<string, TreeNode> = {}
  const childrenOf: Record<string, string[]> = {}
  const sectionOf: Record<string, SectionType> = {}
  const wordCountRollup: Record<string, number> = {}

  const sorted = [...nodes].sort(byPosition)
  for (const node of sorted) byId[node.id] = node
  const rootIds: string[] = []
  for (const node of sorted) {
    if (node.parentId === null) {
      rootIds.push(node.id)
    } else {
      ;(childrenOf[node.parentId] ??= []).push(node.id)
    }
  }

  const visit = (id: string, section: SectionType): number => {
    const node = byId[id]
    if (!node) return 0
    sectionOf[id] = section
    let total = node.kind === 'document' ? node.wordCount : 0
    for (const childId of childrenOf[id] ?? []) total += visit(childId, section)
    wordCountRollup[id] = total
    return total
  }
  for (const rootId of rootIds) {
    const sectionType = byId[rootId]?.sectionType
    if (sectionType) visit(rootId, sectionType)
  }

  return { byId, childrenOf, rootIds, sectionOf, wordCountRollup }
}

/**
 * Merges a freshly created node into the index without a reload (F-2.2). Siblings at or after
 * its position shift down by one. Ancestor word-count rollups are unchanged because created nodes
 * start at 0 words; do not reuse this for duplicate (F-2.3), whose copies carry words.
 */
export function insertIntoIndex(index: TreeIndex, node: TreeNode): TreeIndex {
  if (node.parentId === null) return index
  const byId: Record<string, TreeNode> = { ...index.byId }
  const siblings = [...(index.childrenOf[node.parentId] ?? [])]
  for (const id of siblings) {
    const sibling = byId[id]
    if (sibling && sibling.position >= node.position) {
      byId[id] = { ...sibling, position: sibling.position + 1 }
    }
  }
  siblings.splice(node.position, 0, node.id)
  byId[node.id] = node
  return {
    byId,
    childrenOf: { ...index.childrenOf, [node.parentId]: siblings, [node.id]: [] },
    rootIds: index.rootIds,
    sectionOf: { ...index.sectionOf, [node.id]: index.sectionOf[node.parentId] ?? 'manuscript' },
    wordCountRollup: { ...index.wordCountRollup, [node.id]: node.wordCount }
  }
}

const emptyIndex = (): TreeIndex => ({
  byId: {},
  childrenOf: {},
  rootIds: [],
  sectionOf: {},
  wordCountRollup: {}
})

/** Bumped by every load() and clear() so a response from a superseded load is dropped. */
let generation = 0

export const useTreeStore = create<TreeState>((set, get) => ({
  ...emptyIndex(),
  selectedId: null,
  collapsed: {},
  loaded: false,
  renamingId: null,
  busy: false,

  async load() {
    const mine = ++generation
    const nodes = await ipc().invoke('tree:list', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    set({ ...buildIndex(nodes), selectedId: null, collapsed: {}, renamingId: null, loaded: true })
  },

  select(id) {
    if (id !== null) {
      if (get().byId[id]?.sectionType !== null) return
    }
    set({ selectedId: id })
  },

  toggle(id) {
    if (get().byId[id]?.kind !== 'folder') return
    const { collapsed } = get()
    set({ collapsed: { ...collapsed, [id]: !collapsed[id] } })
  },

  clear() {
    generation++
    set({
      ...emptyIndex(),
      selectedId: null,
      collapsed: {},
      loaded: false,
      renamingId: null,
      busy: false
    })
  },

  startRename(id) {
    if (get().byId[id]?.sectionType !== null) return
    set({ renamingId: id })
  },

  endRename() {
    set({ renamingId: null })
  },

  async createLevel(level, targetId) {
    const state = get()
    const target = resolveCreateTarget(state, targetId ?? state.selectedId, level)
    if (!target) return
    await createAt(target, level === 'scene' ? 'document' : 'folder', level)
  },

  async createGeneric(kind, targetId) {
    const target = resolveGenericTarget(get(), targetId)
    if (!target) return
    await createAt(target, kind, null)
  },

  async rename(id, title) {
    const mine = generation
    set({ busy: true })
    try {
      const node = await ipc().invoke('tree:rename', { id, title })
      if (mine !== generation) return
      set((s) => ({
        byId: { ...s.byId, [id]: node },
        renamingId: s.renamingId === id ? null : s.renamingId
      }))
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }
}))

/** Shared tail of `createLevel` and `createGeneric`: invoke, merge, expand, select, rename. */
async function createAt(
  target: CreateTarget,
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel | null
): Promise<void> {
  const mine = generation
  useTreeStore.setState({ busy: true })
  try {
    const node = await ipc().invoke('tree:create', {
      parentId: target.parentId,
      afterId: target.afterId,
      kind,
      hierarchyLevel
    })
    if (mine !== generation) return // the project was closed while the request was in flight
    useTreeStore.setState((s) => {
      const collapsed = { ...s.collapsed }
      for (let id: string | null = node.parentId; id !== null; id = s.byId[id]?.parentId ?? null) {
        collapsed[id] = false
      }
      return { ...insertIntoIndex(s, node), collapsed, selectedId: node.id, renamingId: node.id }
    })
  } finally {
    if (mine === generation) useTreeStore.setState({ busy: false })
  }
}
