import { resolveDropTarget, type DropTarget } from '@renderer/features/manuscript/placement'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'

/** Which half of a card the pointer is over during a drag: the dragged card lands before or after it. */
export type CardSide = 'before' | 'after'

/**
 * Where dropping card `dragId` on the `side` of card `hoverId` lands (F-11.1), or null when the
 * drop changes nothing or is not allowed. The cork board reorders siblings only, so both cards
 * must share a parent; the rest (no-op drops, level rules) is the tree's own `resolveDropTarget`.
 */
export function cardDropTarget(
  index: TreeIndex,
  dragId: string,
  hoverId: string,
  side: CardSide
): DropTarget | null {
  const dragged = index.byId[dragId]
  if (!dragged || dragged.parentId !== index.byId[hoverId]?.parentId) return null
  return resolveDropTarget(index, dragId, hoverId, side)
}

/** The keyboard move of a card (Alt+ArrowLeft / Alt+ArrowRight): one place earlier or later, or null at an end. */
export function cardStepTarget(index: TreeIndex, id: string, step: -1 | 1): DropTarget | null {
  const parentId = index.byId[id]?.parentId
  if (parentId == null) return null
  const siblings = index.childrenOf[parentId] ?? []
  const neighbour = siblings[siblings.indexOf(id) + step]
  if (neighbour === undefined) return null
  return cardDropTarget(index, id, neighbour, step < 0 ? 'before' : 'after')
}
