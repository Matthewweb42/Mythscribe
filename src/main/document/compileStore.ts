import { compiledSceneMeta, type CompiledEntry, type CompiledManuscript } from '@shared/compile'
import type { CompileNode, CompileSource } from '@shared/compileModel'
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

/** The node rows of one section in reading order, each with its depth below the section root. */
function walkSection(
  section: SectionType,
  rows: readonly NodeRow[]
): { row: NodeRow; depth: number }[] {
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
  const out: { row: NodeRow; depth: number }[] = []
  const walk = (parentId: string, depth: number): void => {
    for (const row of children.get(parentId) ?? []) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(root.id, 0)
  return out
}

/**
 * One section's descendants in reading order (F-3.12, F-12.1): one read of the tree (unless the
 * caller passes the rows it already has) and one of the tag links, then a preorder walk of the
 * section root's descendants in position order, so the entries read the way the book does (a
 * part, its chapters, their scenes). Content that does not parse is null rather than a throw,
 * like every other whole-manuscript read. Choosing chapters and leaving documents out is the
 * compile model's (`selectEntries` in `@shared/compileModel`).
 */
export function compileSection(
  db: TreeDb,
  section: SectionType,
  rows: readonly NodeRow[] = listNodes(db)
): CompiledEntry[] {
  const tagsByNode = listAllLinkedTags(db)
  return walkSection(section, rows).map(({ row, depth }) => compiledEntry(row, depth, tagsByNode))
}

/**
 * The compile model's source (Compile v2): the front matter, manuscript, and end matter in
 * reading order, each node with its synopsis and notes. One read of the tree and of the tag
 * links; unreadable content or notes read as null, an unreadable synopsis as ''.
 */
export function compileSource(db: TreeDb): CompileSource {
  const rows = listNodes(db)
  const tagsByNode = listAllLinkedTags(db)
  const nodes = (section: SectionType): CompileNode[] =>
    walkSection(section, rows).map(({ row, depth }) => ({
      ...compiledEntry(row, depth, tagsByNode),
      synopsis: parseStoredSceneMeta(row.sceneMeta).synopsis,
      notes: documentJson({ content: row.notes })
    }))
  return { front: nodes('front'), manuscript: nodes('manuscript'), end: nodes('end') }
}

/**
 * The compiled preview (F-3.12), main side: the manuscript section in reading order. Front and
 * end matter never appear.
 */
export function compileManuscript(db: TreeDb): CompiledManuscript {
  return { entries: compileSection(db, 'manuscript') }
}
