import { create } from 'zustand'
import type { TreeNode } from '@shared/ipc/contract'
import type { HierarchyLevel, NodeKind, SectionType } from '@shared/labels'
import type { MatterTemplateId } from '@shared/matterTemplates'
import { useEntityStore } from '@renderer/features/entities/entityStore'
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
  /** `wordCountRollup` as it was when the project loaded; the session delta (F-3.3) is measured from it. */
  sessionBaseline: Record<string, number>
  selectedId: string | null
  collapsed: Record<string, boolean>
  /**
   * The tag the tree is filtered by (F-4.10), or null for the whole tree. Tree view state like
   * `collapsed`: the Manuscript tab's filter bar and the Tag Manager's "Show in tree" both write
   * it. A filter whose tag has since left the bank reads as no filter.
   */
  tagFilter: string | null
  loaded: boolean
  /** The node whose title is being edited inline (F-2.2), if any. */
  renamingId: string | null
  /** True while a create, rename, duplicate, delete, or move request is in flight; the create buttons disable on it. */
  busy: boolean
  load: () => Promise<void>
  /** Selects a document or folder. Section roots are not selectable. */
  select: (id: string | null) => void
  /** Collapses or expands a folder or section. Documents are ignored. */
  toggle: (id: string) => void
  clear: () => void
  /** Filters the tree by a tag, or clears the filter with null (F-4.10). */
  setTagFilter: (tagId: string | null) => void
  startRename: (id: string) => void
  endRename: () => void
  /**
   * Creates a part/chapter/scene relative to `targetId` (default: the selection) per
   * `resolveCreateTarget`, then selects the new node and opens inline rename. No-op when there is
   * no valid placement. Errors propagate so the caller can show them.
   */
  createLevel: (level: HierarchyLevel, targetId?: string, options?: CreateOptions) => Promise<void>
  /** Creates a generic document or folder relative to `targetId` per `resolveGenericTarget`. */
  createGeneric: (kind: NodeKind, targetId: string, options?: CreateOptions) => Promise<void>
  /**
   * Creates a front/end matter document from a template relative to `targetId` per
   * `resolveGenericTarget` (F-2.6): merges the returned row, adds its words to every ancestor's
   * rollup, expands the ancestors, and selects it. No inline rename: the template title is the
   * real title. No-op when there is no valid placement. Errors propagate.
   */
  createFromTemplate: (templateId: MatterTemplateId, targetId: string) => Promise<void>
  /**
   * Creates a titled chapter or scene under `parentId`, right after `afterId` (null: last), and
   * answers it, leaving the selection and inline rename alone (F-5.22, the chat agent's edits).
   * Errors propagate.
   */
  createIn: (
    level: 'chapter' | 'scene',
    parentId: string,
    afterId: string | null,
    title: string
  ) => Promise<TreeNode | null>
  /** Renames a node and ends its inline rename. Errors propagate. */
  rename: (id: string, title: string) => Promise<void>
  /**
   * Duplicates a node and its subtree right after it (F-2.3), then expands the ancestors and
   * selects the copy. Errors propagate.
   */
  duplicate: (id: string) => Promise<void>
  /**
   * Deletes a node and its subtree (F-2.3; the caller confirms first). If the selection was
   * inside it, falls back per `planRemoval`. Errors propagate.
   */
  remove: (id: string) => Promise<void>
  /**
   * Moves a node with its subtree under `parentId` (F-2.4): `afterId` omitted → last child,
   * null → first child, an id → right after that sibling. Expands the destination's ancestors;
   * the selection is untouched. Errors propagate so the caller can show them.
   */
  move: (id: string, parentId: string, afterId?: string | null) => Promise<void>
  /** Records a document's saved word count (F-3.2) and adjusts its ancestors' rollups by the delta. */
  setWordCount: (id: string, wordCount: number) => void
  /**
   * Like `setWordCount`, but the session baseline moves with it, so the session delta stays put:
   * for text that changed without being written this session (a draft switch or revert, F-8.5).
   */
  rebaseWordCount: (id: string, wordCount: number) => void
}

/** `keepSelection`: leave the current selection alone (the stacked view adds a region in place, F-3.8). */
export interface CreateOptions {
  keepSelection?: boolean
}

/** What `createAt` adds on top of the public options. */
interface CreateAtOptions extends CreateOptions {
  /** Fill the document from a front/end matter template (F-2.6). */
  template?: MatterTemplateId
  /** Open inline rename on the new node; default true. Off for templates, whose title is meaningful. */
  rename?: boolean
  /** The new node's title; omitted lets main name it "Untitled …". */
  title?: string
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

/**
 * Merges the rows returned by `tree:duplicate` (the copy's root first) into the index without a
 * reload (F-2.3). Siblings after the original shift down by one; the index is rebuilt from the
 * local rows plus the new ones so word-count rollups include the copied words.
 */
export function duplicateIntoIndex(index: TreeIndex, rows: TreeNode[]): TreeIndex {
  const root = rows[0]
  if (root?.parentId == null) return index
  const nodes = Object.values(index.byId).map((existing) =>
    existing.parentId === root.parentId && existing.position >= root.position
      ? { ...existing, position: existing.position + 1 }
      : existing
  )
  return buildIndex([...nodes, ...rows])
}

/** The node and every descendant, via `childrenOf`. */
function subtreeIds(index: TreeIndex, id: string): Set<string> {
  const ids = new Set<string>()
  const walk = (current: string): void => {
    ids.add(current)
    for (const childId of index.childrenOf[current] ?? []) walk(childId)
  }
  walk(id)
  return ids
}

export interface Removal {
  /** The deleted node and every descendant. */
  removed: Set<string>
  /**
   * The selection after the delete: unchanged when it was outside the subtree, otherwise the next
   * sibling, then the previous sibling, then the parent unless it is a section root, else null.
   */
  selectedId: string | null
}

/** What deleting `id` takes with it and where the selection lands (F-2.3). Null for section roots and unknown ids. */
export function planRemoval(
  index: TreeIndex,
  id: string,
  selectedId: string | null
): Removal | null {
  const node = index.byId[id]
  if (node?.parentId == null) return null
  const removed = subtreeIds(index, id)
  if (selectedId === null || !removed.has(selectedId)) return { removed, selectedId }
  const siblings = index.childrenOf[node.parentId] ?? []
  const at = siblings.indexOf(id)
  const parent = index.byId[node.parentId]
  const fallback =
    siblings[at + 1] ?? siblings[at - 1] ?? (parent?.sectionType === null ? parent.id : null)
  return { removed, selectedId: fallback }
}

/**
 * Drops `id` and its subtree from the index without a reload (F-2.3). Later siblings close the
 * gap; the index is rebuilt from the remaining local rows so word-count rollups drop the deleted words.
 */
export function removeFromIndex(index: TreeIndex, id: string): TreeIndex {
  const node = index.byId[id]
  if (node?.parentId == null) return index
  const removed = subtreeIds(index, id)
  const nodes: TreeNode[] = []
  for (const existing of Object.values(index.byId)) {
    if (removed.has(existing.id)) continue
    nodes.push(
      existing.parentId === node.parentId && existing.position > node.position
        ? { ...existing, position: existing.position - 1 }
        : existing
    )
  }
  return buildIndex(nodes)
}

/**
 * Merges the row returned by `tree:move` into the index without a reload (F-2.4). The old
 * siblings close the gap, the new siblings at or after the landing position shift down, and the
 * index is rebuilt from the local rows so word-count rollups follow the moved words. Returns the
 * index unchanged for section roots and unknown ids.
 */
export function moveInIndex(index: TreeIndex, moved: TreeNode): TreeIndex {
  const before = index.byId[moved.id]
  if (before?.parentId == null || moved.parentId === null) return index
  const nodes: TreeNode[] = []
  for (const existing of Object.values(index.byId)) {
    if (existing.id === moved.id) continue
    let position = existing.position
    if (existing.parentId === before.parentId && position > before.position) position -= 1
    if (existing.parentId === moved.parentId && position >= moved.position) position += 1
    nodes.push(position === existing.position ? existing : { ...existing, position })
  }
  nodes.push(moved)
  return buildIndex(nodes)
}

/**
 * Patches a document's word count after a save (F-3.2) without a rebuild or a request: the node's
 * own count and the rollup of the node and every ancestor move by the delta. Returns the index
 * unchanged for unknown ids and when nothing changed.
 */
export function setWordCountInIndex(index: TreeIndex, id: string, wordCount: number): TreeIndex {
  const node = index.byId[id]
  if (!node) return index
  const delta = wordCount - node.wordCount
  if (delta === 0) return index
  const wordCountRollup = { ...index.wordCountRollup }
  for (let current: string | null = id; current !== null;) {
    wordCountRollup[current] = (wordCountRollup[current] ?? 0) + delta
    current = index.byId[current]?.parentId ?? null
  }
  return {
    ...index,
    byId: { ...index.byId, [id]: { ...node, wordCount } },
    wordCountRollup
  }
}

/**
 * Every document under `id`, depth-first in position order (F-3.8): the documents a folder
 * shows stacked. A document id yields itself; an empty folder or unknown id yields nothing.
 */
export function descendantDocuments(
  index: Pick<TreeIndex, 'byId' | 'childrenOf'>,
  id: string
): string[] {
  const ids: string[] = []
  const walk = (current: string): void => {
    const node = index.byId[current]
    if (!node) return
    if (node.kind === 'document') {
      ids.push(current)
      return
    }
    for (const childId of index.childrenOf[current] ?? []) walk(childId)
  }
  walk(id)
  return ids
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
  sessionBaseline: {},
  selectedId: null,
  collapsed: {},
  tagFilter: null,
  loaded: false,
  renamingId: null,
  busy: false,

  async load() {
    const mine = ++generation
    const nodes = await ipc().invoke('tree:list', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    const index = buildIndex(nodes)
    set({
      ...index,
      sessionBaseline: { ...index.wordCountRollup },
      selectedId: null,
      collapsed: {},
      tagFilter: null,
      renamingId: null,
      loaded: true
    })
  },

  select(id) {
    if (id !== null) {
      if (get().byId[id]?.sectionType !== null) return
      // F-9.3: picking a document closes the entity page, whoever asked for the selection (the
      // tree, a passage link, the tag detail, the assistant, an import), so the main pane always
      // shows what was just selected — a click on the already-selected node included.
      useEntityStore.getState().select(null)
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
      sessionBaseline: {},
      selectedId: null,
      collapsed: {},
      tagFilter: null,
      loaded: false,
      renamingId: null,
      busy: false
    })
  },

  setTagFilter(tagId) {
    set({ tagFilter: tagId })
  },

  startRename(id) {
    if (get().byId[id]?.sectionType !== null) return
    set({ renamingId: id })
  },

  endRename() {
    set({ renamingId: null })
  },

  async createLevel(level, targetId, options) {
    const state = get()
    const target = resolveCreateTarget(state, targetId ?? state.selectedId, level)
    if (!target) return
    await createAt(target, level === 'scene' ? 'document' : 'folder', level, options)
  },

  async createGeneric(kind, targetId, options) {
    const target = resolveGenericTarget(get(), targetId)
    if (!target) return
    await createAt(target, kind, null, options)
  },

  async createFromTemplate(templateId, targetId) {
    const target = resolveGenericTarget(get(), targetId)
    if (!target) return
    await createAt(target, 'document', null, { template: templateId, rename: false })
  },

  createIn(level, parentId, afterId, title) {
    return createAt(
      afterId === null ? { parentId } : { parentId, afterId },
      level === 'scene' ? 'document' : 'folder',
      level,
      { keepSelection: true, rename: false, title }
    )
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
  },

  async duplicate(id) {
    const mine = generation
    set({ busy: true })
    try {
      const rows = await ipc().invoke('tree:duplicate', { id })
      if (mine !== generation) return
      const root = rows[0]
      if (!root) return
      set((s) => ({
        ...duplicateIntoIndex(s, rows),
        collapsed: expandAncestors(s, root.parentId),
        selectedId: root.id
      }))
    } finally {
      if (mine === generation) set({ busy: false })
    }
  },

  async remove(id) {
    const mine = generation
    set({ busy: true })
    try {
      await ipc().invoke('tree:delete', { id })
      if (mine !== generation) return
      set((s) => {
        const plan = planRemoval(s, id, s.selectedId)
        if (!plan) return {}
        const collapsed = { ...s.collapsed }
        for (const removedId of plan.removed) delete collapsed[removedId]
        return {
          ...removeFromIndex(s, id),
          collapsed,
          selectedId: plan.selectedId,
          renamingId: s.renamingId !== null && plan.removed.has(s.renamingId) ? null : s.renamingId
        }
      })
    } finally {
      if (mine === generation) set({ busy: false })
    }
  },

  async move(id, parentId, afterId) {
    const mine = generation
    set({ busy: true })
    try {
      const node = await ipc().invoke('tree:move', { id, parentId, afterId })
      if (mine !== generation) return
      set((s) => ({ ...moveInIndex(s, node), collapsed: expandAncestors(s, node.parentId) }))
    } finally {
      if (mine === generation) set({ busy: false })
    }
  },

  setWordCount(id, wordCount) {
    set((s) => setWordCountInIndex(s, id, wordCount))
  },

  rebaseWordCount(id, wordCount) {
    set((s) => {
      const next = setWordCountInIndex(s, id, wordCount)
      if (next === s) return s
      const sessionBaseline = { ...s.sessionBaseline }
      for (const [key, rollup] of Object.entries(next.wordCountRollup)) {
        const moved = rollup - (s.wordCountRollup[key] ?? 0)
        const base = sessionBaseline[key]
        if (moved !== 0 && base !== undefined) sessionBaseline[key] = base + moved
      }
      return { ...next, sessionBaseline }
    })
  }
}))

/**
 * Words added to (or removed from) a node since the project was opened (F-3.3). A node created
 * this session has no baseline, so its whole count is new.
 */
export function sessionDelta(
  state: Pick<TreeState, 'wordCountRollup' | 'sessionBaseline'>,
  id: string
): number {
  return (state.wordCountRollup[id] ?? 0) - (state.sessionBaseline[id] ?? 0)
}

/**
 * The collapse map with every ancestor from `parentId` up to the section root opened. Exported
 * for the merges that live outside this store (F-12.2's import writes a whole subtree and then
 * reveals its first scene) so there is one owner of what "expand to it" means.
 */
export function expandAncestors(
  state: Pick<TreeIndex, 'byId'> & { collapsed: Record<string, boolean> },
  parentId: string | null
): Record<string, boolean> {
  const collapsed = { ...state.collapsed }
  for (let id = parentId; id !== null; id = state.byId[id]?.parentId ?? null) {
    collapsed[id] = false
  }
  return collapsed
}

/**
 * The rollup map with `delta` added to every ancestor from `parentId` up to the section root.
 * `insertIntoIndex` assumes a new node has no words; a templated document (F-2.6) arrives with some.
 */
function addToAncestorRollups(
  index: TreeIndex,
  parentId: string | null,
  delta: number
): Record<string, number> {
  if (delta === 0) return index.wordCountRollup
  const wordCountRollup = { ...index.wordCountRollup }
  for (let id = parentId; id !== null; id = index.byId[id]?.parentId ?? null) {
    wordCountRollup[id] = (wordCountRollup[id] ?? 0) + delta
  }
  return wordCountRollup
}

/**
 * Shared tail of `createLevel`, `createGeneric`, and `createFromTemplate`: invoke, merge (with
 * the new node's words), expand, select (unless kept), rename (unless off).
 */
async function createAt(
  target: CreateTarget,
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel | null,
  options?: CreateAtOptions
): Promise<TreeNode | null> {
  const mine = generation
  useTreeStore.setState({ busy: true })
  try {
    const node = await ipc().invoke('tree:create', {
      parentId: target.parentId,
      afterId: target.afterId,
      kind,
      hierarchyLevel,
      ...(options?.template === undefined ? {} : { template: options.template }),
      ...(options?.title === undefined ? {} : { title: options.title })
    })
    if (mine !== generation) return null // the project was closed while the request was in flight
    useTreeStore.setState((s) => {
      const merged = insertIntoIndex(s, node)
      return {
        ...merged,
        wordCountRollup: addToAncestorRollups(merged, node.parentId, node.wordCount),
        collapsed: expandAncestors(s, node.parentId),
        selectedId: options?.keepSelection ? s.selectedId : node.id,
        renamingId: options?.rename === false ? s.renamingId : node.id
      }
    })
    return node
  } finally {
    if (mine === generation) useTreeStore.setState({ busy: false })
  }
}
