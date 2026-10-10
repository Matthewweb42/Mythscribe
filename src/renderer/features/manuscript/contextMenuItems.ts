import type { NovelFormat } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, levelLabel } from '@shared/labels'
import { MatterTemplateId, matterTemplatesFor } from '@shared/matterTemplates'
import { resolveGenericTarget, resolveMenuCreateTarget } from './placement'
import type { TreeIndex } from './treeStore'

export interface MenuItem {
  id: string
  label: string
  /** Shown but not choosable (F-9.5: an export with nothing to export); absent means choosable. */
  disabled?: boolean
  /** The item's tooltip: what it does, or why it is disabled; absent means none. */
  title?: string
  /** A checkbox item (F-12.4 Include in compile) and whether it is ticked; absent: a plain item. */
  checked?: boolean
}

/** The id of the `Include in compile` checkbox item (F-12.4). */
export const INCLUDE_ITEM_ID = 'include-compile'

/** Prefix of the template items' ids (F-2.6): `template:<MatterTemplateId>`. */
const TEMPLATE_ITEM_PREFIX = 'template:'

/** The template behind a menu item id, or null when the id is not a (known) template item. */
export function templateIdOf(itemId: string): MatterTemplateId | null {
  if (!itemId.startsWith(TEMPLATE_ITEM_PREFIX)) return null
  const parsed = MatterTemplateId.safeParse(itemId.slice(TEMPLATE_ITEM_PREFIX.length))
  return parsed.success ? parsed.data : null
}

/**
 * The right-click menu for a tree row (F-2.2), section-aware: manuscript rows offer the levels,
 * scene first, that can be placed relative to them (`resolveMenuCreateTarget`: right inside a clicked root,
 * part, or chapter when it can hold the level) plus a generic document and folder; front and
 * end matter rows offer the generic items followed by their section's templates as `New <Title>` (F-2.6).
 * Documents and folders (never sections) also offer Rename, Duplicate, and Delete (F-2.3), and
 * those in the manuscript `Set word target…`, plus `Clear word target` when `hasTarget` (F-10.3),
 * and, once the compile state is known (`included` given), the `Include in compile` checkbox
 * (F-12.4).
 */
export function treeContextMenuItems(
  index: TreeIndex,
  nodeId: string,
  format: NovelFormat,
  hasTarget = false,
  included?: boolean
): MenuItem[] {
  const items: MenuItem[] = []
  if (index.sectionOf[nodeId] === 'manuscript') {
    // Scene first: the order of how often each is made.
    for (const level of [...HIERARCHY_LEVELS].reverse()) {
      if (resolveMenuCreateTarget(index, nodeId, level) !== null) {
        items.push({ id: `new-${level}`, label: `New ${levelLabel(format, level)}` })
      }
    }
  }
  const section = index.sectionOf[nodeId]
  if (resolveGenericTarget(index, nodeId) !== null) {
    items.push({ id: 'new-generic-document', label: 'New document' })
    items.push({ id: 'new-generic-folder', label: 'New folder' })
    if (section === 'front' || section === 'end') {
      for (const template of matterTemplatesFor(section)) {
        items.push({ id: `${TEMPLATE_ITEM_PREFIX}${template.id}`, label: `New ${template.title}` })
      }
    }
  }
  if (index.byId[nodeId]?.sectionType === null) {
    items.push({ id: 'rename', label: 'Rename' })
    items.push({ id: 'duplicate', label: 'Duplicate' })
    items.push({ id: 'delete', label: 'Delete' })
    if (section === 'manuscript') {
      items.push({ id: 'set-target', label: 'Set word target…' })
      if (hasTarget) items.push({ id: 'clear-target', label: 'Clear word target' })
    }
    if (included !== undefined)
      items.push({ id: INCLUDE_ITEM_ID, label: 'Include in compile', checked: included })
  }
  return items
}
