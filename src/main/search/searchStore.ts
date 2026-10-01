import { eq } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import { ENTITY_FIELDS, ENTITY_KIND_NOUN } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import {
  EMPTY_SEARCH_RESPONSE,
  SEARCH_MAX_RESULTS,
  buildSnippet,
  findOccurrences,
  isSearchable,
  normalizeQuery,
  searchableText,
  type SearchRange,
  type SearchRequest,
  type SearchResponse,
  type SearchResult
} from '@shared/search'
import { documentTag, tagMention, type NodeRow } from '../db/schema'
import { parseStoredTiptap } from '../document/documentStore'
import { listEntities } from '../entity/entityStore'
import { listNodes, type TreeDb } from '../tree/treeStore'

/**
 * Global search (F-10.1): one scan of the stored text per query, no index table. A novel is a
 * few hundred scenes, so matching plain strings is fast; what is not is parsing every Tiptap
 * document again on each keystroke, hence the text cache below.
 */

/** The searchable text of one stored Tiptap column, kept while the stored JSON string is the same. */
interface CachedText {
  source: string
  text: string
}

/** Keyed `<column>:<node id>`. Belongs to the open project: `clearSearchCache` on every project change. */
const textCache = new Map<string, CachedText>()

/** Drops every cached text (the project closed or another one opened). */
export function clearSearchCache(): void {
  textCache.clear()
}

/** How many texts are cached. For tests. */
export function searchCacheSize(): number {
  return textCache.size
}

/**
 * The searchable text of a stored Tiptap column. A null column and one that no longer parses
 * both read as no text: one corrupt row must not fail every search.
 */
function storedText(column: 'content' | 'notes', id: string, raw: string | null): string {
  if (raw === null) return ''
  const key = `${column}:${id}`
  const cached = textCache.get(key)
  if (cached?.source === raw) return cached.text
  const text = readText(column, id, raw)
  textCache.set(key, { source: raw, text })
  return text
}

function readText(column: 'content' | 'notes', id: string, raw: string): string {
  try {
    return searchableText(docToText(parseStoredTiptap(raw, id, column)))
  } catch {
    return ''
  }
}

/**
 * Every node below the section roots in the order the tree shows them: sorted by each row's chain
 * of positions from its root (`listNodes` orders by parent id, which is not reading order across
 * chapters). The roots themselves are left out: they carry neither content nor notes. Shared with
 * find and replace (F-10.2).
 */
export function nodesInTreeOrder(rows: NodeRow[]): NodeRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const paths = new Map<string, number[]>()
  const pathOf = (row: NodeRow): number[] => {
    const known = paths.get(row.id)
    if (known !== undefined) return known
    const parent = row.parentId === null ? undefined : byId.get(row.parentId)
    const path = parent === undefined ? [row.position] : [...pathOf(parent), row.position]
    paths.set(row.id, path)
    return path
  }
  const compare = (a: NodeRow, b: NodeRow): number => {
    const left = pathOf(a)
    const right = pathOf(b)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const l = left[i] ?? -1
      const r = right[i] ?? -1
      if (l !== r) return l - r
    }
    return a.id.localeCompare(b.id)
  }
  return rows.filter((row) => row.parentId !== null).sort(compare)
}

/**
 * Where a node sits, for a result row: the parent, and the grandparent too unless it is a section
 * root — scenes and chapters repeat their titles ("Scene 1" under every "Chapter 1"), so one
 * level does not tell them apart. Shared with find and replace (F-10.2).
 */
export function nodeLocation(byId: ReadonlyMap<string, NodeRow>, row: NodeRow): string {
  const parent = row.parentId === null ? undefined : byId.get(row.parentId)
  if (!parent) return ''
  const grand = parent.parentId === null ? undefined : byId.get(parent.parentId)
  const path = grand && grand.parentId !== null ? [grand.title, parent.title] : [parent.title]
  return searchableText(path.join(' › '))
}

/** The nodes the tag is linked to or mentioned in (the F-4.10 meaning), in two queries. */
function nodeIdsWithTag(db: TreeDb, tagId: string): Set<string> {
  const linked = db
    .select({ nodeId: documentTag.nodeId })
    .from(documentTag)
    .where(eq(documentTag.tagId, tagId))
    .all()
  const mentioned = db
    .select({ nodeId: tagMention.nodeId })
    .from(tagMention)
    .where(eq(tagMention.tagId, tagId))
    .all()
  return new Set([...linked, ...mentioned].map((row) => row.nodeId))
}

/** A matching source before its snippet is cut: only the rows under the cap pay for one. */
type Hit = () => SearchResult

/** One text of an entity: a template field (with its label) or the blank page (no label). */
interface EntityText {
  field: string | null
  text: string
}

function entityTexts(entity: Entity): EntityText[] {
  const texts: EntityText[] = []
  for (const def of ENTITY_FIELDS[entity.kind]) {
    const value = entity.fields[def.id]
    if (value !== undefined) texts.push({ field: def.label, text: searchableText(value) })
  }
  if (entity.body !== null) texts.push({ field: null, text: searchableText(entity.body) })
  return texts.filter((entry) => entry.text !== '')
}

function nodeHit(
  type: 'document' | 'notes',
  row: NodeRow,
  location: string,
  query: string,
  text: string,
  withTitle: boolean
): Hit | null {
  const title = searchableText(row.title)
  const titleHighlights: SearchRange[] = withTitle ? findOccurrences(title, query) : []
  const occurrences = findOccurrences(text, query)
  const count = titleHighlights.length + occurrences.length
  if (count === 0) return null
  return () => ({
    type,
    id: row.id,
    title,
    location,
    field: null,
    snippet: buildSnippet(text, occurrences),
    titleHighlights,
    count
  })
}

function entityHit(entity: Entity, query: string): Hit | null {
  const title = searchableText(entity.name)
  const titleHighlights = findOccurrences(title, query)
  const texts = entityTexts(entity).map((entry) => ({
    ...entry,
    occurrences: findOccurrences(entry.text, query)
  }))
  const count = texts.reduce((sum, entry) => sum + entry.occurrences.length, titleHighlights.length)
  if (count === 0) return null
  // The snippet comes from the first text that matches; a name-only hit shows the first text.
  const matched = texts.find((entry) => entry.occurrences.length > 0)
  const shown = matched ?? texts[0]
  return () => ({
    type: entity.kind,
    id: entity.id,
    title,
    location: ENTITY_KIND_NOUN[entity.kind],
    field: matched?.field ?? null,
    snippet: buildSnippet(shown?.text ?? '', shown?.occurrences ?? []),
    titleHighlights,
    count
  })
}

/**
 * Searches the open project (F-10.1): documents (title and text) in tree order, then notes in
 * tree order, then entities (name, template fields, page) in story-bible order; one result per
 * matching source, the first `SEARCH_MAX_RESULTS` of them. A query shorter than the minimum, and
 * a request with no type, answer nothing rather than failing.
 */
export function searchProject(db: TreeDb, request: SearchRequest): SearchResponse {
  const query = normalizeQuery(request.query)
  if (!isSearchable(query) || request.types.length === 0) return EMPTY_SEARCH_RESPONSE
  const types = new Set(request.types)
  const hits: Hit[] = []
  const add = (hit: Hit | null): void => {
    if (hit !== null) hits.push(hit)
  }

  if (types.has('document') || types.has('notes')) {
    const rows = listNodes(db)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const tagged = request.tagId === null ? null : nodeIdsWithTag(db, request.tagId)
    const nodes = nodesInTreeOrder(rows).filter((row) => tagged === null || tagged.has(row.id))
    const locationOf = (row: NodeRow): string => nodeLocation(byId, row)
    if (types.has('document')) {
      for (const row of nodes) {
        if (row.kind !== 'document') continue
        const text = storedText('content', row.id, row.content)
        add(nodeHit('document', row, locationOf(row), query, text, true))
      }
    }
    if (types.has('notes')) {
      for (const row of nodes) {
        if (row.notes === null) continue
        const text = storedText('notes', row.id, row.notes)
        add(nodeHit('notes', row, locationOf(row), query, text, false))
      }
    }
  }

  if (types.has('character') || types.has('setting') || types.has('world')) {
    for (const entity of listEntities(db)) {
      if (!types.has(entity.kind)) continue
      if (request.tagId !== null && entity.tagId !== request.tagId) continue
      add(entityHit(entity, query))
    }
  }

  return {
    results: hits.slice(0, SEARCH_MAX_RESULTS).map((hit) => hit()),
    total: hits.length,
    truncated: hits.length > SEARCH_MAX_RESULTS
  }
}
