import type { TreeNode } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, canPlaceLevel, type HierarchyLevel } from '@shared/labels'
import type { TreeIndex } from './treeStore'

/**
 * Where a new node goes (F-2.2). `afterId` omitted means "append as the last child of `parentId`".
 */
export interface CreateTarget {
  parentId: string
  afterId?: string
}

/** Lower number = higher in the hierarchy (part < chapter < scene). */
const rank = (level: HierarchyLevel): number => HIERARCHY_LEVELS.indexOf(level)

function manuscriptRootId(index: TreeIndex): string | null {
  return index.rootIds.find((id) => index.byId[id]?.sectionType === 'manuscript') ?? null
}

/** The nearest ancestor of `node` (inclusive) that has a hierarchy level, or null if none. */
function nearestLeveled(index: TreeIndex, node: TreeNode): TreeNode | null {
  let current: TreeNode | undefined = node
  while (current) {
    if (current.hierarchyLevel !== null) return current
    if (current.parentId === null) return null
    current = index.byId[current.parentId]
  }
  return null
}

/**
 * The nearest of `node` and its ancestors whose parent can hold `level` (`canPlaceLevel`), or
 * null if none: a new chapter after a scene goes after that scene's chapter, or after the scene
 * itself when it sits directly under a part or the manuscript root.
 */
function holderChild(index: TreeIndex, node: TreeNode, level: HierarchyLevel): TreeNode | null {
  let current: TreeNode | undefined = node
  while (current?.parentId != null) {
    const parent: TreeNode | undefined = index.byId[current.parentId]
    if (parent && canPlaceLevel(level, parent)) return current
    current = parent
  }
  return null
}

/** Last child of `parentId` that has a hierarchy level, skipping generic siblings. */
function lastLeveledChild(index: TreeIndex, parentId: string): TreeNode | null {
  const children = index.childrenOf[parentId] ?? []
  for (let i = children.length - 1; i >= 0; i--) {
    const child = index.byId[children[i] ?? '']
    if (child?.hierarchyLevel != null) return child
  }
  return null
}

/**
 * Descends from `parentId` along the bottom of the outline: while the last leveled child sits
 * higher than `level` (so it can hold it), steps into it, then appends there. With flexible
 * nesting every stop can hold the level, so a part with no chapters takes a new scene itself.
 */
function appendTarget(index: TreeIndex, parentId: string, level: HierarchyLevel): CreateTarget {
  let current = parentId
  let last = lastLeveledChild(index, current)
  while (last?.hierarchyLevel != null && rank(last.hierarchyLevel) < rank(level)) {
    current = last.id
    last = lastLeveledChild(index, current)
  }
  return { parentId: current }
}

/**
 * Resolves where a new part/chapter/scene goes relative to the selected node (F-2.2: the create
 * bar, Insert, and the empty-folder invitation).
 *
 * - Same level as the target: sibling right after it.
 * - Higher level than the target: sibling after the nearest of the target and its ancestors
 *   whose parent can hold the level (its chapter, or a scene that sits right under a part).
 * - Lower level than the target (or no target): appended at the bottom of the existing chain.
 *
 * Returns null when the target lives outside the manuscript section.
 */
export function resolveCreateTarget(
  index: TreeIndex,
  targetId: string | null,
  level: HierarchyLevel
): CreateTarget | null {
  const rootId = manuscriptRootId(index)
  if (!rootId) return null

  const selected = targetId === null || targetId === rootId ? undefined : index.byId[targetId]
  let target: TreeNode | null = null
  if (selected) {
    if (index.sectionOf[selected.id] !== 'manuscript') return null
    target = nearestLeveled(index, selected)
  }

  if (target?.hierarchyLevel == null) {
    return appendTarget(index, rootId, level)
  }

  const targetRank = rank(target.hierarchyLevel)
  const wanted = rank(level)

  if (wanted === targetRank) {
    return target.parentId === null ? null : { parentId: target.parentId, afterId: target.id }
  }

  if (wanted < targetRank) {
    const sibling = holderChild(index, target, level)
    if (sibling?.parentId == null) return null
    return { parentId: sibling.parentId, afterId: sibling.id }
  }

  return appendTarget(index, target.id, level)
}

/**
 * Where the tree's right-click "New <level>" puts a node (F-2.2, flexible nesting decided by the
 * author 2026-10-07): directly inside the clicked manuscript root, part, or chapter as its last
 * child when that folder can hold the level (a scene right under a part, a chapter right under
 * the root); otherwise the create bar's rule, so a new part from a part goes after it.
 */
export function resolveMenuCreateTarget(
  index: TreeIndex,
  nodeId: string,
  level: HierarchyLevel
): CreateTarget | null {
  const node = index.byId[nodeId]
  if (
    node?.kind === 'folder' &&
    index.sectionOf[nodeId] === 'manuscript' &&
    (node.sectionType === 'manuscript' || node.hierarchyLevel !== null) &&
    canPlaceLevel(level, node)
  ) {
    return { parentId: node.id }
  }
  return resolveCreateTarget(index, nodeId, level)
}

/**
 * Resolves where a generic document or folder goes (F-2.2): inside a folder or section as its
 * last child, or right after a document. Works in every section.
 */
export function resolveGenericTarget(index: TreeIndex, targetId: string): CreateTarget | null {
  const target = index.byId[targetId]
  if (!target) return null
  if (target.kind === 'folder') return { parentId: target.id }
  return target.parentId === null ? null : { parentId: target.parentId, afterId: target.id }
}

/** Where the pointer sits over a row while dragging (F-2.4). */
export type DropZone = 'before' | 'after' | 'into'

/** Where a dragged node lands (F-2.4); same tri-state `afterId` as `tree:move`. */
export interface DropTarget {
  parentId: string
  /** Omitted → last child of `parentId`; null → first child; id → right after that sibling. */
  afterId?: string | null
}

/** True when `ancestorId` is `id` or one of its ancestors. */
function isWithin(index: TreeIndex, id: string, ancestorId: string): boolean {
  let current: TreeNode | undefined = index.byId[id]
  while (current) {
    if (current.id === ancestorId) return true
    current = current.parentId === null ? undefined : index.byId[current.parentId]
  }
  return false
}

/**
 * Resolves where dropping `dragId` on `hoverId` in `zone` would land (F-2.4), or null when the
 * drop is not allowed: onto itself or its own subtree, across sections, before/after a section
 * root, into a document, where `canPlaceLevel` forbids the level, or where nothing would change.
 * `before` and `after` make the node a sibling of the hovered row; `into` appends it as the
 * hovered folder's last child.
 */
export function resolveDropTarget(
  index: TreeIndex,
  dragId: string,
  hoverId: string,
  zone: DropZone
): DropTarget | null {
  const dragged = index.byId[dragId]
  const hovered = index.byId[hoverId]
  if (!dragged || !hovered || dragged.parentId === null) return null
  if (dragId === hoverId || isWithin(index, hoverId, dragId)) return null
  if (index.sectionOf[dragId] !== index.sectionOf[hoverId]) return null

  let target: DropTarget
  if (zone === 'into') {
    if (hovered.kind !== 'folder') return null
    const siblings = index.childrenOf[hoverId] ?? []
    if (siblings.at(-1) === dragId) return null
    target = { parentId: hoverId }
  } else {
    if (hovered.parentId === null) return null
    const siblings = index.childrenOf[hovered.parentId] ?? []
    const at = siblings.indexOf(hoverId)
    if (zone === 'before') {
      const previous = siblings[at - 1] ?? null
      if (previous === dragId) return null
      target = { parentId: hovered.parentId, afterId: previous }
    } else {
      if (siblings[at + 1] === dragId) return null
      target = { parentId: hovered.parentId, afterId: hoverId }
    }
  }

  const parent = index.byId[target.parentId]
  if (!parent || !canPlaceLevel(dragged.hierarchyLevel, parent)) return null
  return target
}
