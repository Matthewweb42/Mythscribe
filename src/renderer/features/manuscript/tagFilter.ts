import type { TreeIndex } from './treeStore'

/** What a tag filter leaves on screen (F-4.10). */
export interface TagFilterView {
  /** The nodes carrying the tag, in tree display order (depth-first, position order). */
  matches: string[]
  /** The matches and every ancestor of a match: the rows the filtered tree renders. */
  visible: Set<string>
}

/**
 * The rows a tag filter leaves visible (F-4.10). A node carrying the tag is a match; its
 * ancestors stay so the match keeps its place in the hierarchy, and a section with no match
 * inside it disappears entirely. A matching folder shows on its own: its children are only
 * visible when they carry the tag too. Pure, so the tree and the filter bar's count read the
 * same view. Ids in `tagIdsByNode` that are not in the index are ignored.
 */
export function tagFilterView(
  index: Pick<TreeIndex, 'rootIds' | 'childrenOf'>,
  tagIdsByNode: Record<string, string[] | undefined>,
  tagId: string
): TagFilterView {
  const matches: string[] = []
  const visible = new Set<string>()
  const ancestors: string[] = []
  const walk = (ids: string[]): void => {
    for (const id of ids) {
      if (tagIdsByNode[id]?.includes(tagId) === true) {
        matches.push(id)
        visible.add(id)
        for (const ancestor of ancestors) visible.add(ancestor)
      }
      ancestors.push(id)
      walk(index.childrenOf[id] ?? [])
      ancestors.pop()
    }
  }
  walk(index.rootIds)
  return { matches, visible }
}
