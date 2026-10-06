import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel, sectionLabel } from '@shared/labels'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { FolderViewToggle } from '@renderer/features/outline/CorkBoard'

/**
 * The selected document's name in the header (2026-10-06, the author's call: the big title strip
 * above the editor is gone so the page gets the room). A folder also gets its stack / cork board
 * switch here. Hidden while an entity sheet has the pane, since the sheet shows its own name.
 */
export function SelectionCrumb({ format }: { format: NovelFormat }): React.JSX.Element | null {
  const entityId = useEntityStore((s) => s.selectedId)
  const node = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  const section = useTreeStore((s) =>
    s.selectedId === null ? undefined : s.sectionOf[s.selectedId]
  )
  if (entityId !== null || !node) return null
  const kind =
    node.hierarchyLevel !== null
      ? levelLabel(format, node.hierarchyLevel)
      : node.kind === 'folder'
        ? 'Folder'
        : 'Document'
  const where = section ? `${kind} · ${sectionLabel(format, section)}` : kind
  return (
    <>
      <span aria-hidden="true" className="text-fg-muted">
        ›
      </span>
      <span className="min-w-0 truncate font-medium text-fg" title={where}>
        <span data-testid="selected-title">{node.title}</span>
        <span className="sr-only"> ({where})</span>
      </span>
      {node.kind === 'folder' ? <FolderViewToggle /> : null}
    </>
  )
}
