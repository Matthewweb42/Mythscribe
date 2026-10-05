import { compiledSceneMeta, type CompiledEntry, type CompiledManuscript } from '@shared/compile'
import type { SectionType } from '@shared/labels'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { NodeRow } from '../db/schema'
import { listAllLinkedTags } from '../tag/documentTagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { documentJson } from '../voice/profile'

/** The tags linked to each node, as `listAllLinkedTags` answers them. */
type TagsByNode = ReturnType<typeof listAllLinkedTags>

/** One node as a compiled entry: its level, depth, title, shown scene metadata, tags, and text. */
export function compiledEntry(row: NodeRow, depth: number, tagsByNode: TagsByNode): CompiledEntry {
  return {
    id: row.id,
    kind: row.kind,
    level: row.hierarchyLevel,
    depth,
    title: row.title,
    meta: compiledSceneMeta(parseStoredSceneMeta(row.sceneMeta)),
    tags: tagsByNode.get(row.id) ?? [],
    content: row.kind === 'document' ? documentJson(row) : null
  }
}

export interface CompileSectionOptions {
  /**
   * Keeps only these nodes, their descendants, and their ancestors (F-12.1 selected chapters:
   * a chosen chapter keeps the part that holds it as a heading, and every scene below it).
   */
  only?: ReadonlySet<string>
}

/**
 * One section's descendants in reading order (F-3.12, F-12.1): one read of the tree (unless the
 * caller passes the rows it already has) and one of the tag links, then a preorder walk of the
 * section root's descendants in position order, so the entries read the way the book does (a
 * part, its chapters, their scenes). Content that does not parse is null rather than a throw,
 * like every other whole-manuscript read.
 */
export function compileSection(
  db: TreeDb,
  section: SectionType,
  options: CompileSectionOptions = {},
  rows: readonly NodeRow[] = listNodes(db)
): CompiledEntry[] {
  const root = rows.find((row) => row.parentId === null && row.sectionType === section)
  if (!root) return []
  // `listNodes` orders by parent, position, id, so each child list is already in reading order.
  const children = new Map<string, NodeRow[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const siblings = children.get(row.parentId)
    if (siblings === undefined) children.set(row.parentId, [row])
    else siblings.push(row)
  }
  const { only } = options
  // The ancestors of every kept node, so the walk can tell a holder of a chosen node from a
  // node with nothing chosen below it.
  const holders = new Set<string>()
  if (only !== undefined) {
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]))
    for (const id of only) {
      let parent = parentOf.get(id) ?? null
      while (parent !== null && !holders.has(parent)) {
        holders.add(parent)
        parent = parentOf.get(parent) ?? null
      }
    }
  }
  const tagsByNode = listAllLinkedTags(db)
  const entries: CompiledEntry[] = []
  const walk = (parentId: string, depth: number, inside: boolean): void => {
    for (const row of children.get(parentId) ?? []) {
      const kept = only === undefined || inside || only.has(row.id)
      if (!kept && !holders.has(row.id)) continue
      entries.push(compiledEntry(row, depth, tagsByNode))
      walk(row.id, depth + 1, kept)
    }
  }
  walk(root.id, 0, false)
  return entries
}

/**
 * The compiled preview (F-3.12), main side: the manuscript section in reading order. Front and
 * end matter never appear.
 */
export function compileManuscript(db: TreeDb): CompiledManuscript {
  return { entries: compileSection(db, 'manuscript') }
}
