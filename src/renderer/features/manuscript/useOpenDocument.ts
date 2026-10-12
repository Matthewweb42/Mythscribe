import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { useTreeStore } from './treeStore'

/**
 * The document open in the editor (not a folder, not an entity page, not a record's sheet), or
 * null. Shared by the dialogs that act on "this document": snapshots (F-8.6) and export (F-12.1).
 */
export function useOpenDocument(): { id: string; title: string } | null {
  const entityId = useEntityStore((s) => s.selectedId)
  // F-16.6 (story memory v2): a record's sheet hides the scene under it, as an entity page does.
  const recordId = useRecordStore((s) => s.selectedId)
  const node = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  if (entityId !== null || recordId !== null || node?.kind !== 'document') return null
  return { id: node.id, title: node.title }
}
