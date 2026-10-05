import { BookOpen, File, FileText, Folder, FolderOpen, Layers } from 'lucide-react'
import type { TreeNode } from '@shared/ipc/contract'
import type { SectionType } from '@shared/labels'

function levelColor(node: TreeNode, section: SectionType): string {
  if (node.kind === 'document' && section !== 'manuscript') return 'text-matter'
  switch (node.hierarchyLevel) {
    case 'part':
      return 'text-level-part'
    case 'chapter':
      return 'text-level-chapter'
    case 'scene':
      return 'text-level-scene'
    case null:
      return 'text-level-generic'
  }
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
  switch (node.hierarchyLevel) {
    case 'part':
      return <Layers {...props} />
    case 'chapter':
      return <BookOpen {...props} />
    case 'scene':
      return <FileText {...props} />
    case null:
      return <File {...props} />
  }
}
