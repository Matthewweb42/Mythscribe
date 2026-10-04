import { compiledSceneMeta, type CompiledEntry, type CompiledManuscript } from '@shared/compile'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { NodeRow } from '../db/schema'
import { listAllLinkedTags } from '../tag/documentTagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { documentJson } from '../voice/profile'

/**
 * The compiled preview (F-3.12), main side: one read of the tree and one of the tag links, then
 * a preorder walk of the manuscript root's descendants in position order, so the entries read
 * the way the book does (a part, its chapters, their scenes). Front and end matter never appear.
 * Content that does not parse is null rather than a throw, like every other whole-manuscript read.
 */
export function compileManuscript(db: TreeDb): CompiledManuscript {
  const rows = listNodes(db)
  const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  if (!root) return { entries: [] }
  // `listNodes` orders by parent, position, id, so each child list is already in reading order.
  const children = new Map<string, NodeRow[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const siblings = children.get(row.parentId)
    if (siblings === undefined) children.set(row.parentId, [row])
    else siblings.push(row)
  }
  const tagsByNode = listAllLinkedTags(db)
  const entries: CompiledEntry[] = []
  const walk = (parentId: string, depth: number): void => {
    for (const row of children.get(parentId) ?? []) {
      entries.push({
        id: row.id,
        kind: row.kind,
        level: row.hierarchyLevel,
        depth,
        title: row.title,
        meta: compiledSceneMeta(parseStoredSceneMeta(row.sceneMeta)),
        tags: tagsByNode.get(row.id) ?? [],
        content: row.kind === 'document' ? documentJson(row) : null
      })
      walk(row.id, depth + 1)
    }
  }
  walk(root.id, 0)
  return { entries }
}
