import { eq } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import { categoryOf, type StoryCategory } from '@shared/categories'
import type { Entity } from '@shared/ipc/contract'
import type { StoryRecordSummary } from '@shared/memory/records'
import {
  EMPTY_SEARCH_RESPONSE,
  RECORD_SEARCH_FIELD,
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
import { documentTag, record, tagMention, type NodeRow } from '../db/schema'
import { parseStoredTiptap } from '../document/documentStore'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { nodesOfLabel } from '../memory/labelStore'
import { listRecords } from '../memory/recordStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { researchSubtree } from '../research/researchTree'

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

/** A stored Tiptap column: a node's text or notes, or (F-16.6) a record's Pinned or Ideas page. */
type TextColumn = 'content' | 'notes' | 'pinned' | 'ideas'

/**
 * Keyed `<column>:<node or record id>`. Belongs to the open project: `clearSearchCache` on every
 * project change.
 */
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
function storedText(column: TextColumn, id: string, raw: string | null): string {
  if (raw === null) return ''
  const key = `${column}:${id}`
  const cached = textCache.get(key)
  if (cached?.source === raw) return cached.text
  const text = readText(column, id, raw)
  textCache.set(key, { source: raw, text })
  return text
}

function readText(column: TextColumn, id: string, raw: string): string {
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

/**
 * One text of a sheet: an entity's template field (with its label) or its blank page (no label),
 * or a record's nicknames, Pinned or Ideas (F-16.6).
 */
interface SheetText {
  field: string | null
  text: string
}

function entityTexts(entity: Entity, category: StoryCategory): SheetText[] {
  const texts: SheetText[] = []
  for (const def of category.fields) {
    const value = entity.fields[def.id]
    if (value !== undefined) texts.push({ field: def.label, text: searchableText(value) })
  }
  if (entity.body !== null) texts.push({ field: null, text: searchableText(entity.body) })
  return texts.filter((entry) => entry.text !== '')
}

function nodeHit(
  type: 'document' | 'notes' | 'research',
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

/**
 * The search type a sheet is found under: its own for the three of F-9.1, World for every other
 * story-bible category (F-9.11), which is where those sheets lived before categories.
 */
function entityType(kind: string): 'character' | 'setting' | 'world' {
  return kind === 'character' || kind === 'setting' ? kind : 'world'
}

/** A sheet as one result: its name as the title, its texts in order, where it lives. */
interface SheetSource {
  type: 'character' | 'setting' | 'world' | 'record'
  id: string
  name: string
  location: string
  texts: readonly SheetText[]
}

function sheetHit(sheet: SheetSource, query: string): Hit | null {
  const title = searchableText(sheet.name)
  const titleHighlights = findOccurrences(title, query)
  const texts = sheet.texts.map((entry) => ({
    ...entry,
    occurrences: findOccurrences(entry.text, query)
  }))
  const count = texts.reduce((sum, entry) => sum + entry.occurrences.length, titleHighlights.length)
  if (count === 0) return null
  // The snippet comes from the first text that matches; a name-only hit shows the first text.
  const matched = texts.find((entry) => entry.occurrences.length > 0)
  const shown = matched ?? texts[0]
  return () => ({
    type: sheet.type,
    id: sheet.id,
    title,
    location: sheet.location,
    field: matched?.field ?? null,
    snippet: buildSnippet(shown?.text ?? '', shown?.occurrences ?? []),
    titleHighlights,
    count
  })
}

function entityHit(entity: Entity, category: StoryCategory, query: string): Hit | null {
  return sheetHit(
    {
      type: entityType(entity.kind),
      id: entity.id,
      name: entity.name,
      location: category.noun,
      texts: entityTexts(entity, category)
    },
    query
  )
}

/** A record's stored pages, as `record` holds them. */
interface RecordPages {
  pinned: string | null
  ideas: string | null
}

/**
 * F-16.6: a record found by its name, a nickname (field "Nicknames"), its Pinned page ("Pinned")
 * or its Ideas ("your idea", never taken as true).
 */
function recordHit(
  summary: StoryRecordSummary,
  pages: RecordPages | undefined,
  category: StoryCategory,
  query: string
): Hit | null {
  const nicknames = summary.aliases.filter((entry) => !entry.isMain).map((entry) => entry.text)
  const texts: SheetText[] = [
    { field: RECORD_SEARCH_FIELD.aliases, text: searchableText(nicknames.join(', ')) },
    {
      field: RECORD_SEARCH_FIELD.pinned,
      text: storedText('pinned', summary.id, pages?.pinned ?? null)
    },
    {
      field: RECORD_SEARCH_FIELD.ideas,
      text: storedText('ideas', summary.id, pages?.ideas ?? null)
    }
  ]
  return sheetHit(
    {
      type: 'record',
      id: summary.id,
      name: summary.name,
      location: category.noun,
      texts: texts.filter((entry) => entry.text !== '')
    },
    query
  )
}

/**
 * Searches the open project (F-10.1): documents (title and text) in tree order, then notes in
 * tree order, then entities (name, template fields, page) in story-bible order, then (story
 * memory v2) records by name (F-16.6: names, Pinned, Ideas) and the Research section's documents
 * as source documents (F-16.8); one result per matching source, the first `SEARCH_MAX_RESULTS`
 * of them. A label filter (F-16.7) keeps the scenes and Research documents carrying the label and
 * their notes; sheets and records carry no labels, so it leaves them out. A query shorter than
 * the minimum, and a request with no type, answer nothing rather than failing.
 */
export function searchProject(db: TreeDb, request: SearchRequest): SearchResponse {
  const query = normalizeQuery(request.query)
  if (!isSearchable(query) || request.types.length === 0) return EMPTY_SEARCH_RESPONSE
  const types = new Set(request.types)
  const hits: Hit[] = []
  const add = (hit: Hit | null): void => {
    if (hit !== null) hits.push(hit)
  }

  const rows =
    types.has('document') || types.has('notes') || types.has('research') ? listNodes(db) : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  // F-16.8: Research is no part of the book: its documents are source documents, not documents.
  const research = researchSubtree(rows)
  const locationOf = (row: NodeRow): string => nodeLocation(byId, row)
  const labelled =
    request.labelId === null || request.labelId === undefined
      ? null
      : new Set(nodesOfLabel(db, request.labelId))
  const hasLabel = (row: NodeRow): boolean => labelled === null || labelled.has(row.id)
  if (types.has('document') || types.has('notes')) {
    const tagged = request.tagId === null ? null : nodeIdsWithTag(db, request.tagId)
    const nodes = nodesInTreeOrder(rows).filter(
      (row) => (tagged === null || tagged.has(row.id)) && hasLabel(row)
    )
    if (types.has('document')) {
      for (const row of nodes) {
        if (row.kind !== 'document' || research.has(row.id)) continue
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

  const sheets = labelled === null
  if (sheets && (types.has('character') || types.has('setting') || types.has('world'))) {
    const categories = listCategories(db)
    for (const entity of listEntities(db)) {
      if (!types.has(entityType(entity.kind))) continue
      if (request.tagId !== null && entity.tagId !== request.tagId) continue
      add(entityHit(entity, categoryOf(entity.kind, categories), query))
    }
  }

  // F-16.6: records carry no tags or labels, so either filter finds none of them.
  if (sheets && types.has('record') && request.tagId === null) {
    const categories = listCategories(db)
    const pages = new Map(
      db
        .select({ id: record.id, pinned: record.pinned, ideas: record.ideas })
        .from(record)
        .all()
        .map((row) => [row.id, row])
    )
    for (const summary of listRecords(db)) {
      add(
        recordHit(summary, pages.get(summary.id), categoryOf(summary.categoryId, categories), query)
      )
    }
  }

  // Research documents carry no tags, so a tag filter finds none of them.
  if (types.has('research') && request.tagId === null && research.size > 0) {
    for (const row of nodesInTreeOrder(rows)) {
      if (row.kind !== 'document' || !research.has(row.id) || !hasLabel(row)) continue
      const text = storedText('content', row.id, row.content)
      // A page right under the Research root has no folder to name.
      const parent = row.parentId === null ? undefined : byId.get(row.parentId)
      const location = parent?.parentId === null ? '' : locationOf(row)
      add(nodeHit('research', row, location, query, text, true))
    }
  }

  return {
    results: hits.slice(0, SEARCH_MAX_RESULTS).map((hit) => hit()),
    total: hits.length,
    truncated: hits.length > SEARCH_MAX_RESULTS
  }
}
