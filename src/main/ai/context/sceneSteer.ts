import { renderSceneSteer } from '@shared/sceneSteer'
import { listDocumentTags } from '../../tag/documentTagStore'
import { getNode, type TreeDb } from '../../tree/treeStore'

/**
 * The scene steer block a prose prompt carries (F-14.13): the tags linked to the node the
 * request is about, rendered by the pure `renderSceneSteer` (Tone, Content, Plot threads,
 * Themes). Null with no node open, for a node that no longer exists or cannot carry tags (a
 * section root; checked here first, since `listDocumentTags` throws for those), and for a node
 * with no tag in a steer category. One query, no cache: the rendered string goes into the
 * feature's context hash, so a retagged scene never answers from a stale cache entry.
 */
export function buildSceneSteer(db: TreeDb, nodeId: string | null): string | null {
  if (nodeId === null) return null
  // An unknown node and a section root (no parent) both read as null.
  if ((getNode(db, nodeId)?.parentId ?? null) === null) return null
  return renderSceneSteer(
    listDocumentTags(db, nodeId).map((tag) => ({ category: tag.category, name: tag.name }))
  )
}
