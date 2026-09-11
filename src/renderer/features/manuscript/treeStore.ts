import { create } from 'zustand'
import type { TreeNode } from '@shared/ipc/contract'
import type { SectionType } from '@shared/labels'
import { ipc } from '@renderer/lib/ipc'

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
  load: () => Promise<void>
  /** Selects a document or folder. Section roots are not selectable. */
  select: (id: string | null) => void
  /** Collapses or expands a folder or section. Documents are ignored. */
  toggle: (id: string) => void
  clear: () => void
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

  async load() {
    const mine = ++generation
    const nodes = await ipc().invoke('tree:list', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    set({ ...buildIndex(nodes), selectedId: null, collapsed: {}, loaded: true })
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
    set({ ...emptyIndex(), selectedId: null, collapsed: {}, loaded: false })
  }
}))
