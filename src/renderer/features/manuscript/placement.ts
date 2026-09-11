import type { TreeNode } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, type HierarchyLevel } from '@shared/labels'
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

/** The nearest ancestor of `node` (inclusive) at exactly `level`, or null if none. */
function ancestorAtLevel(index: TreeIndex, node: TreeNode, level: HierarchyLevel): TreeNode | null {
  let current: TreeNode | undefined = node
  while (current) {
    if (current.hierarchyLevel === level) return current
    current = current.parentId === null ? undefined : index.byId[current.parentId]
  }
  return null
}

/** Last child of `parentId` whose hierarchy level is `level`, skipping generic siblings. */
function lastChildAtLevel(
  index: TreeIndex,
  parentId: string,
  level: HierarchyLevel
): TreeNode | null {
  const children = index.childrenOf[parentId] ?? []
  for (let i = children.length - 1; i >= 0; i--) {
    const child = index.byId[children[i] ?? '']
    if (child?.hierarchyLevel === level) return child
  }
  return null
}

/**
 * Descends the level chain from `parentId`, taking the last child at each level from `from` down
 * to (but not including) `level`, and returns the parent to append to. Null when a level in
 * between is missing (e.g. New Scene under a part that has no chapters).
 */
function appendTarget(
  index: TreeIndex,
  parentId: string,
  from: number,
  level: HierarchyLevel
): CreateTarget | null {
  let current = parentId
  for (let i = from; i < rank(level); i++) {
    const step = HIERARCHY_LEVELS[i]
    if (!step) return null
    const last = lastChildAtLevel(index, current, step)
    if (!last) return null
    current = last.id
  }
  return { parentId: current }
}

/**
 * Resolves where a new part/chapter/scene goes relative to the selected node (F-2.2).
 *
 * - Same level as the target: sibling right after it.
 * - Higher level than the target: sibling after the enclosing ancestor at that level.
 * - Lower level than the target (or no target): appended at the bottom of the existing chain.
 *
 * Returns null when the target lives outside the manuscript section or when an intermediate
 * level is missing (a part with no chapters cannot receive a scene).
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
    return appendTarget(index, rootId, 0, level)
  }

  const targetRank = rank(target.hierarchyLevel)
  const wanted = rank(level)

  if (wanted === targetRank) {
    return target.parentId === null ? null : { parentId: target.parentId, afterId: target.id }
  }

  if (wanted < targetRank) {
    const ancestor = ancestorAtLevel(index, target, level)
    if (ancestor?.parentId == null) return null
    return { parentId: ancestor.parentId, afterId: ancestor.id }
  }

  return appendTarget(index, target.id, targetRank + 1, level)
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
