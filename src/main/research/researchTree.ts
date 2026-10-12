import { and, eq, isNull } from 'drizzle-orm'
import { node, type NodeRow } from '../db/schema'
import { getNode, type TreeDb } from '../tree/treeStore'

/**
 * Where the Research section (F-16.8, story memory v2) sits in the tree: the one owner of "the
 * Research root" and "under Research". The seed, the Research store, the passage index, search,
 * snapshots, the voice profile's book list and the chat agent all ask here. Kept apart from
 * `researchStore.ts` so the tree's readers do not import the upload path.
 */

/** Whether `row` is the Research root itself. */
export const isResearchRoot = (row: Pick<NodeRow, 'parentId' | 'sectionType'>): boolean =>
  row.parentId === null && row.sectionType === 'research'

/** The Research root's id, or null: a v1 project, or a v2 one not opened yet. */
export function researchRootId(db: TreeDb): string | null {
  return (
    db
      .select({ id: node.id })
      .from(node)
      .where(and(isNull(node.parentId), eq(node.sectionType, 'research')))
      .get()?.id ?? null
  )
}

/**
 * Whether `row` sits under the Research root (the root itself is not "in" it), walking its
 * parents one row at a time: cheap for one node, where `researchSubtree` reads the whole tree.
 */
export function isUnderResearch(db: TreeDb, row: NodeRow): boolean {
  for (let parentId = row.parentId; parentId !== null; ) {
    const parent = getNode(db, parentId)
    if (parent === undefined) return false
    if (parent.parentId === null) return parent.sectionType === 'research'
    parentId = parent.parentId
  }
  return false
}

/**
 * The rows of the subtree under `rootId`, `rootId` first and the rest in preorder by position
 * (the order the tree shows them). Empty when `rootId` is not among `rows`.
 */
export function subtreeInOrder(rows: readonly NodeRow[], rootId: string): NodeRow[] {
  const root = rows.find((row) => row.id === rootId)
  if (root === undefined) return []
  const children = new Map<string, NodeRow[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = children.get(row.parentId)
    if (list) list.push(row)
    else children.set(row.parentId, [row])
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  }
  const order: NodeRow[] = []
  const walk = (row: NodeRow): void => {
    order.push(row)
    for (const child of children.get(row.id) ?? []) walk(child)
  }
  walk(root)
  return order
}

/** The ids of the Research root and every node under it, in tree order; empty when there is none. */
export function researchSubtree(rows: readonly NodeRow[]): Set<string> {
  const root = rows.find(isResearchRoot)
  if (root === undefined) return new Set()
  return new Set(subtreeInOrder(rows, root.id).map((row) => row.id))
}

/** The ids of every document under the Research root, in the order the tree shows them. */
export function researchDocumentIds(rows: readonly NodeRow[]): string[] {
  const root = rows.find(isResearchRoot)
  if (root === undefined) return []
  return subtreeInOrder(rows, root.id)
    .filter((row) => row.kind === 'document')
    .map((row) => row.id)
}
