import type { TreeNode } from '@shared/ipc/contract'
import type { HierarchyLevel, NodeKind, SectionType } from '@shared/labels'

/**
 * Test fixture shaped like the webnovel seed (F-1.3): three sections, Arc 1–2 → Chapter × 3 →
 * one scene each (17 rows), plus one front-matter document. Rows are deliberately listed out of
 * position order so ordering is exercised. Titles are unique so tests can address rows by name.
 */
function node(
  id: string,
  parentId: string | null,
  position: number,
  title: string,
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel | null,
  wordCount = 0,
  sectionType: SectionType | null = null,
  matterType: string | null = null
): TreeNode {
  return {
    id,
    parentId,
    sectionType,
    kind,
    hierarchyLevel,
    title,
    position,
    wordCount,
    matterType,
    preset: null,
    created: '2026-09-10T12:00:00.000Z',
    modified: '2026-09-10T12:00:00.000Z'
  }
}

export const treeFixture: TreeNode[] = [
  node('end', null, 2, 'end', 'folder', null, 0, 'end'),
  node('front', null, 0, 'front', 'folder', null, 0, 'front'),
  node('manuscript', null, 1, 'manuscript', 'folder', null, 0, 'manuscript'),
  node('title-page', 'front', 0, 'Title Page', 'document', null, 12, null, 'title-page'),
  node('arc-2', 'manuscript', 1, 'Arc 2', 'folder', 'part'),
  node('arc-1', 'manuscript', 0, 'Arc 1', 'folder', 'part'),
  node('ch-3', 'arc-1', 2, 'Chapter 3', 'folder', 'chapter'),
  node('ch-1', 'arc-1', 0, 'Chapter 1', 'folder', 'chapter'),
  node('ch-2', 'arc-1', 1, 'Chapter 2', 'folder', 'chapter'),
  node('ch-4', 'arc-2', 0, 'Chapter 4', 'folder', 'chapter'),
  node('ch-5', 'arc-2', 1, 'Chapter 5', 'folder', 'chapter'),
  node('ch-6', 'arc-2', 2, 'Chapter 6', 'folder', 'chapter'),
  node('sc-1', 'ch-1', 0, 'Scene 1', 'document', 'scene', 1200),
  node('sc-2', 'ch-2', 0, 'Scene 2', 'document', 'scene', 800),
  node('sc-3', 'ch-3', 0, 'Scene 3', 'document', 'scene', 0),
  node('sc-4', 'ch-4', 0, 'Scene 4', 'document', 'scene', 2500),
  node('sc-5', 'ch-5', 0, 'Scene 5', 'document', 'scene', 0),
  node('sc-6', 'ch-6', 0, 'Scene 6', 'document', 'scene', 300)
]
