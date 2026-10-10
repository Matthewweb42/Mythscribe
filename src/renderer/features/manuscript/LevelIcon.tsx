import { File, Folder, FolderOpen } from 'lucide-react'
import type { TreeNode } from '@shared/ipc/contract'
import type { SectionType } from '@shared/labels'
import { LEVEL_GLYPH } from './levelGlyph'

function levelColor(node: TreeNode, section: SectionType): string {
  if (node.kind === 'document' && section !== 'manuscript') return 'text-matter'
  return node.hierarchyLevel === null
    ? 'text-level-generic'
    : LEVEL_GLYPH[node.hierarchyLevel].color
}

/**
 * Per-level icon in its level colour: sections and generic folders show a folder, levels their
 * own glyph, generic documents a plain file, front and end matter documents the matter colour.
 * Shared by the Manuscript tree (F-2.1) and the cork board's cards (F-11.1).
 */
export function LevelIcon({
  node,
  section,
  expanded,
  className = ''
}: {
  node: TreeNode
  section: SectionType
  expanded: boolean
  className?: string
}): React.JSX.Element {
  const props = {
    size: 14,
    'aria-hidden': true,
    className: `shrink-0 ${levelColor(node, section)} ${className}`
  }
  if (node.sectionType !== null || (node.kind === 'folder' && node.hierarchyLevel === null)) {
    return expanded ? <FolderOpen {...props} /> : <Folder {...props} />
  }
  const Icon = node.hierarchyLevel === null ? File : LEVEL_GLYPH[node.hierarchyLevel].icon
  return <Icon {...props} />
}
