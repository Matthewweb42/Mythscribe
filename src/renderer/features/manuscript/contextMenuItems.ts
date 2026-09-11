import type { NovelFormat } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, levelLabel } from '@shared/labels'
import { resolveCreateTarget, resolveGenericTarget } from './placement'
import type { TreeIndex } from './treeStore'

export interface MenuItem {
  id: string
  label: string
}

/**
 * The right-click menu for a tree row (F-2.2), section-aware: manuscript rows offer the levels
 * that can be placed relative to them plus a generic document and folder; front and end matter
 * rows offer only the generic items. Documents and folders (never sections) also offer Rename,
 * Duplicate, and Delete (F-2.3).
 */
export function treeContextMenuItems(
  index: TreeIndex,
  nodeId: string,
  format: NovelFormat
): MenuItem[] {
  const items: MenuItem[] = []
  if (index.sectionOf[nodeId] === 'manuscript') {
    for (const level of HIERARCHY_LEVELS) {
      if (resolveCreateTarget(index, nodeId, level) !== null) {
        items.push({ id: `new-${level}`, label: `New ${levelLabel(format, level)}` })
      }
    }
  }
  if (resolveGenericTarget(index, nodeId) !== null) {
    items.push({ id: 'new-generic-document', label: 'New document' })
    items.push({ id: 'new-generic-folder', label: 'New folder' })
  }
  // F-2.6: append the "From template…" group here.
  if (index.byId[nodeId]?.sectionType === null) {
    items.push({ id: 'rename', label: 'Rename' })
    items.push({ id: 'duplicate', label: 'Duplicate' })
    items.push({ id: 'delete', label: 'Delete' })
  }
  return items
}
