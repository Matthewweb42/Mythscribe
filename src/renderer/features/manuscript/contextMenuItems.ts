import type { NovelFormat } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, levelLabel } from '@shared/labels'
import { MatterTemplateId, matterTemplatesFor } from '@shared/matterTemplates'
import { resolveCreateTarget, resolveGenericTarget } from './placement'
import type { TreeIndex } from './treeStore'

export interface MenuItem {
  id: string
  label: string
}

/** Prefix of the template items' ids (F-2.6): `template:<MatterTemplateId>`. */
const TEMPLATE_ITEM_PREFIX = 'template:'

/** The template behind a menu item id, or null when the id is not a (known) template item. */
export function templateIdOf(itemId: string): MatterTemplateId | null {
  if (!itemId.startsWith(TEMPLATE_ITEM_PREFIX)) return null
  const parsed = MatterTemplateId.safeParse(itemId.slice(TEMPLATE_ITEM_PREFIX.length))
  return parsed.success ? parsed.data : null
}

/**
 * The right-click menu for a tree row (F-2.2), section-aware: manuscript rows offer the levels
 * that can be placed relative to them plus a generic document and folder; front and end matter
 * rows offer the generic items followed by their section's templates as `New <Title>` (F-2.6).
 * Documents and folders (never sections) also offer Rename, Duplicate, and Delete (F-2.3).
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
  }
  return items
}
