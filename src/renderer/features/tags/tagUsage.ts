import type { MentionRange, TagMentions } from '@shared/mentions'
import type { TreeNode } from '@shared/ipc/contract'
import { tagFilterView } from '@renderer/features/manuscript/tagFilter'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'

/**
 * One document a tag reaches (F-4.12, F-9.4): it is linked to it, its name occurs in it, or both.
 * `first` is the recorded range of the first occurrence, the jump's starting point, and null when
 * the tag is only linked there.
 */
export interface TagSceneRow {
  id: string
  title: string
  /** The parent folder's title, or null when the parent is a section root (its label is generic). */
  parentTitle: string | null
  /** True when the document carries the tag explicitly (the tag bar, an inline tag, F-4.4). */
  tagged: boolean
  /** How often main's scan found the tag's name in the saved text; 0 when it found none. */
  mentionCount: number
  first: MentionRange | null
}

/**
 * Where a tag appears, in tree display order: the union of the explicit links and the recorded
 * mentions, one row per document. The union is fed to `tagFilterView` as if every row were a
 * link, so one walk of the tree orders the lot and a link and a mention of the same document are
 * one row. Pure, so the Tag Manager's detail (F-4.10, F-4.12) and the entity page's Scenes
 * section (F-9.4) read exactly the same list.
 */
export function sceneRowsForTag(
  index: Pick<TreeIndex, 'rootIds' | 'childrenOf'>,
  byId: Record<string, TreeNode | undefined>,
  tagIdsByNode: Record<string, string[] | undefined>,
  mentions: TagMentions[] | undefined,
  tagId: string
): TagSceneRow[] {
  const rows = mentions ?? []
  const byNode = new Map(rows.map((row) => [row.nodeId, row]))
  const union: Record<string, string[] | undefined> = {}
  for (const [id, tagIds] of Object.entries(tagIdsByNode)) {
    if (tagIds?.includes(tagId) === true) union[id] = [tagId]
  }
  for (const row of rows) union[row.nodeId] = [tagId]
  return tagFilterView(index, union, tagId).matches.flatMap((id) => {
    const node = byId[id]
    if (!node) return []
    const parent = node.parentId === null ? undefined : byId[node.parentId]
    const mention = byNode.get(id)
    return [
      {
        id,
        title: node.title,
        parentTitle: parent?.sectionType === null ? parent.title : null,
        tagged: tagIdsByNode[id]?.includes(tagId) === true,
        mentionCount: mention?.count ?? 0,
        // A mention row always carries at least one range; `[0, 0]` would make the jump search.
        first: mention === undefined ? null : (mention.ranges[0] ?? [0, 0])
      }
    ]
  })
}
