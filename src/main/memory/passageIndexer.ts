import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import { passageParagraphs } from '@shared/mentions'
import { markedParagraphs } from '@shared/memory/pageMarks'
import {
  DEFAULT_PASSAGE_SOURCES,
  MEMORY_PASSAGE_SEARCH_MAX,
  passageCanon,
  passageLabel,
  type MemoryOwnerKind,
  type MemoryPassageHit,
  type PassageCanon,
  type PassageSource
} from '@shared/memory/passages'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import { card, memoryScan, record, researchDoc, type NodeRow } from '../db/schema'
import { currentDraftId } from '../draft/draftStore'
import { AppError } from '../ipc/errors'
import { getCompileState } from '../project/settingsStore'
import { isUnderResearch, researchDocumentIds } from '../research/researchTree'
import { ftsQuery } from '../search/passageIndex'
import { getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { deleteScanRow, getScanHashes, scanHashesOf, setScanHash } from './scanStore'

/**
 * The passage index of story memory v2 (F-16.5): the one writer of `memory_passage_fts`
 * (migration 0031, a virtual table drizzle does not model, so it is read and written with plain
 * SQL). One row per paragraph with text, labelled by source and canon status (`passageCanon`:
 * `notCanon` for everything never real, marked or by place):
 * - a scene's paragraphs are `scene`, or `ideaScene` when it (or a folder above it) has the Idea
 *   status, or `excludedScene` when it is left out of compile;
 * - a scene's notes are `sceneNote`;
 * - a record's Pinned paragraphs are `pinned` and its Ideas `idea`, each `notCanon` where marked;
 * - a Research page's paragraphs (F-16.8) are `note` when the author wrote it in MythScribe and
 *   `research` when it was made from an upload, every one `notCanon` when the page is switched
 *   Not canon, else where marked;
 * - a scene's card in the active draft (F-16.18), its line and its gist, are `card`, always
 *   `notCanon`: a map, findable and never cited (owner kind `card`, keyed by the scene).
 * An owner is skipped while its rows hash as they did (`memory_scan.passages_hash`). Local and
 * free; nothing leaves the machine.
 */

/** Bumped when what goes into the index changes, so every owner is written again. */
export const MEMORY_PASSAGE_INDEX_VERSION = 2

/** Tokens of context `snippet()` keeps around the match. */
const SNIPPET_TOKENS = 16

interface PassageRow {
  source: PassageSource
  para: number
  canon: PassageCanon
  text: string
}

const SOURCES_OF: Record<MemoryOwnerKind, readonly PassageSource[]> = {
  scene: ['scene', 'ideaScene', 'excludedScene'],
  sceneNote: ['sceneNote'],
  record: ['pinned', 'idea'],
  research: ['note', 'research'],
  card: ['card']
}

function parseDoc(raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    const parsed = TiptapNode.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The page's rows under one source, Not canon where marked (or everywhere, for a page switched Not canon). */
function pageRows(
  doc: TiptapNodeT | null,
  source: PassageSource,
  pageNotCanon = false
): PassageRow[] {
  if (doc === null) return []
  return markedParagraphs(doc).map((paragraph) => ({
    source,
    para: paragraph.index,
    canon: passageCanon(source, pageNotCanon || paragraph.notCanon),
    text: paragraph.text
  }))
}

/**
 * What the scenes of the manuscript read as: the node ids that are Idea scenes (the node or a
 * folder above it has the Idea status) and the ones left out of compile (the node or a folder
 * above it unticked). Built once per pass.
 */
export interface SceneStatuses {
  idea: ReadonlySet<string>
  excluded: ReadonlySet<string>
}

export function sceneStatuses(db: TreeDb, rows: readonly NodeRow[] = listNodes(db)): SceneStatuses {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const unticked = new Set(getCompileState(db).excluded)
  const idea = new Set<string>()
  const excluded = new Set<string>()
  for (const row of rows) {
    let at: NodeRow | undefined = row
    while (at !== undefined) {
      if (parseStoredSceneMeta(at.sceneMeta).status === 'idea') idea.add(row.id)
      if (unticked.has(at.id)) excluded.add(row.id)
      at = at.parentId === null ? undefined : byId.get(at.parentId)
    }
  }
  return { idea, excluded }
}

function sceneSource(id: string, statuses: SceneStatuses): PassageSource {
  if (statuses.idea.has(id)) return 'ideaScene'
  if (statuses.excluded.has(id)) return 'excludedScene'
  return 'scene'
}

function sceneRows(row: NodeRow, statuses: SceneStatuses): PassageRow[] {
  const doc = parseDoc(row.content)
  if (doc === null) return []
  const source = sceneSource(row.id, statuses)
  return passageParagraphs(doc).map((paragraph) => ({
    source,
    para: paragraph.index,
    canon: passageCanon(source, false),
    text: paragraph.text
  }))
}

const noteRows = (row: NodeRow): PassageRow[] => pageRows(parseDoc(row.notes), 'sceneNote')

function recordRows(db: TreeDb, id: string): PassageRow[] | null {
  const row = db
    .select({ pinned: record.pinned, ideas: record.ideas })
    .from(record)
    .where(eq(record.id, id))
    .get()
  if (row === undefined) return null
  return [...pageRows(parseDoc(row.pinned), 'pinned'), ...pageRows(parseDoc(row.ideas), 'idea')]
}

/** A scene's card rows (F-16.18): the active draft's line (¶0) and gist (¶1), when it has a card. */
function cardRows(db: TreeDb, nodeId: string): PassageRow[] {
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const row = db
    .select({ line: card.line, gist: card.gist })
    .from(card)
    .where(and(eq(card.nodeId, nodeId), eq(card.draftId, draftId)))
    .get()
  if (row === undefined) return []
  return [row.line, row.gist].flatMap((text, para) =>
    text.trim() === ''
      ? []
      : [{ source: 'card' as const, para, canon: passageCanon('card', false), text }]
  )
}

/** A Research page's rows (F-16.8): `note` for a written page, `research` for an upload. */
function researchRows(db: TreeDb, row: NodeRow): PassageRow[] {
  const meta = db
    .select({ origin: researchDoc.origin, notCanon: researchDoc.notCanon })
    .from(researchDoc)
    .where(eq(researchDoc.nodeId, row.id))
    .get()
  const source: PassageSource = meta?.origin === 'upload' ? 'research' : 'note'
  return pageRows(parseDoc(row.content), source, meta?.notCanon === true)
}

const rowsHash = (rows: readonly PassageRow[]): string =>
  sha256(
    JSON.stringify({
      v: MEMORY_PASSAGE_INDEX_VERSION,
      rows: rows.map((row) => [row.source, row.para, row.canon, row.text])
    })
  )

/** Replaces one owner's rows (the caller holds the transaction). */
function replaceRows(
  db: TreeDb,
  kind: MemoryOwnerKind,
  id: string,
  rows: readonly PassageRow[]
): void {
  for (const source of SOURCES_OF[kind]) {
    db.run(sql`DELETE FROM memory_passage_fts WHERE owner_id = ${id} AND source = ${source}`)
  }
  for (const row of rows) {
    db.run(
      sql`INSERT INTO memory_passage_fts (source, owner_id, para, canon, text)
          VALUES (${row.source}, ${id}, ${row.para}, ${row.canon}, ${row.text})`
    )
  }
}

/** Writes an owner's rows unless they hash as they did; answers whether anything was written. */
function writeOwner(
  db: TreeDb,
  kind: MemoryOwnerKind,
  id: string,
  rows: readonly PassageRow[],
  now: Date
): boolean {
  const hash = rowsHash(rows)
  if (getScanHashes(db, kind, id).passagesHash === hash) return false
  db.transaction((tx) => {
    replaceRows(tx, kind, id, rows)
    setScanHash(tx, kind, id, 'passages', hash, now)
  })
  return true
}

/**
 * Indexes one owner: a scene's text (`scene`), a scene's notes (`sceneNote`), a record's pages
 * (`record`), or a Research page (`research`). A scene that is not a manuscript document, a
 * Research id that is not a Research document, or a record that is gone, throws NOT_FOUND (quiet
 * for the queue).
 */
export function indexOwner(db: TreeDb, kind: MemoryOwnerKind, id: string, now: Date): boolean {
  if (kind === 'record') {
    const rows = recordRows(db, id)
    if (rows === null) throw new AppError('NOT_FOUND', 'That record no longer exists', { id })
    return writeOwner(db, 'record', id, rows, now)
  }
  if (kind === 'research') {
    const row = getNode(db, id)
    if (row?.kind !== 'document' || !isUnderResearch(db, row)) {
      throw new AppError('NOT_FOUND', 'Not a Research document', { id })
    }
    return writeOwner(db, 'research', id, researchRows(db, row), now)
  }
  const nodes = listNodes(db)
  const row = manuscriptDocuments(db, nodes).find((document) => document.id === id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Not a manuscript document', { id })
  if (kind === 'sceneNote') return writeOwner(db, 'sceneNote', id, noteRows(row), now)
  if (kind === 'card') {
    // A scene that never had a card has nothing to index and keeps no scan row.
    const rows = cardRows(db, id)
    if (rows.length === 0 && getScanHashes(db, 'card', id).passagesHash === null) return false
    return writeOwner(db, 'card', id, rows, now)
  }
  return writeOwner(db, 'scene', id, sceneRows(row, sceneStatuses(db, nodes)), now)
}

/** A scene's text, its notes and its card (the active draft's), as one `passages` job does. */
export function indexScene(db: TreeDb, nodeId: string, now: Date): boolean {
  const text = indexOwner(db, 'scene', nodeId, now)
  const notes = indexOwner(db, 'sceneNote', nodeId, now)
  const map = indexOwner(db, 'card', nodeId, now)
  return text || notes || map
}

/**
 * What one `passages` job keyed to a node indexes: a Research page (F-16.8) when the node is a
 * Research document, else the scene and its notes (NOT_FOUND for anything else).
 */
export function indexNodePassages(db: TreeDb, nodeId: string, now: Date): boolean {
  const row = getNode(db, nodeId)
  if (row?.kind === 'document' && isUnderResearch(db, row)) {
    return indexOwner(db, 'research', nodeId, now)
  }
  return indexScene(db, nodeId, now)
}

/** One owner the index is behind on. */
export interface StaleOwner {
  kind: MemoryOwnerKind
  id: string
}

/** The records whose pages would index differently now, oldest first. */
function staleRecordOwners(db: TreeDb): StaleOwner[] {
  const records = scanHashesOf(db, 'record')
  return db
    .select({ id: record.id })
    .from(record)
    .orderBy(asc(record.created))
    .all()
    .filter(({ id }) => records.get(id)?.passagesHash !== rowsHash(recordRows(db, id) ?? []))
    .map(({ id }) => ({ kind: 'record', id }))
}

/**
 * Every owner whose rows would read differently now: scenes (and notes) in reading order, then
 * Research pages in tree order, then records.
 */
export function stalePassageOwners(db: TreeDb): StaleOwner[] {
  const nodes = listNodes(db)
  const statuses = sceneStatuses(db, nodes)
  const scenes = scanHashesOf(db, 'scene')
  const notes = scanHashesOf(db, 'sceneNote')
  const cards = scanHashesOf(db, 'card')
  const stale: StaleOwner[] = []
  for (const row of manuscriptDocuments(db, nodes)) {
    if (scenes.get(row.id)?.passagesHash !== rowsHash(sceneRows(row, statuses))) {
      stale.push({ kind: 'scene', id: row.id })
    }
    if (notes.get(row.id)?.passagesHash !== rowsHash(noteRows(row))) {
      stale.push({ kind: 'sceneNote', id: row.id })
    }
    const cardHash = cards.get(row.id)?.passagesHash ?? null
    const cardText = cardRows(db, row.id)
    if (cardHash === null ? cardText.length > 0 : cardHash !== rowsHash(cardText)) {
      stale.push({ kind: 'card', id: row.id })
    }
  }
  const research = scanHashesOf(db, 'research')
  const byId = new Map(nodes.map((row) => [row.id, row]))
  for (const id of researchDocumentIds(nodes)) {
    const row = byId.get(id)
    if (row !== undefined && research.get(id)?.passagesHash !== rowsHash(researchRows(db, row))) {
      stale.push({ kind: 'research', id })
    }
  }
  return [...stale, ...staleRecordOwners(db)]
}

/** Indexes every stale record page (the `passages` job keyed to the manuscript root); scenes are not read. */
export function indexStaleRecords(db: TreeDb, now: Date): number {
  let written = 0
  for (const owner of staleRecordOwners(db)) {
    if (indexOwner(db, 'record', owner.id, now)) written += 1
  }
  return written
}

/** Drops an owner's rows and its hashes (a record deleted). */
export function dropOwner(db: TreeDb, kind: MemoryOwnerKind, id: string): void {
  db.transaction((tx) => {
    replaceRows(tx, kind, id, [])
    deleteScanRow(tx, kind, id)
  })
}

/** The live owners of each kind: manuscript documents, Research documents, records. */
interface LiveOwners {
  scenes: ReadonlySet<string>
  research: ReadonlySet<string>
  records: ReadonlySet<string>
}

function liveOwners(db: TreeDb, nodes: NodeRow[] = listNodes(db)): LiveOwners {
  return {
    scenes: new Set(manuscriptDocuments(db, nodes).map((row) => row.id)),
    research: new Set(researchDocumentIds(nodes)),
    records: new Set(
      db
        .select({ id: record.id })
        .from(record)
        .all()
        .map((row) => row.id)
    )
  }
}

/** The owner kind a passage row's source belongs to. */
function ownerKindOf(source: PassageSource): MemoryOwnerKind {
  if (source === 'pinned' || source === 'idea') return 'record'
  if (source === 'sceneNote') return 'sceneNote'
  if (source === 'card') return 'card'
  if (source === 'note' || source === 'research') return 'research'
  return 'scene'
}

function isAlive(live: LiveOwners, kind: MemoryOwnerKind, id: string): boolean {
  if (kind === 'record') return live.records.has(id)
  if (kind === 'research') return live.research.has(id)
  return live.scenes.has(id)
}

/**
 * Drops the rows and scan hashes of every owner that is gone (a scene deleted or moved out of
 * the manuscript, a Research document deleted, a record deleted), so one that comes back is
 * indexed afresh. Runs on open. Answers how many owners went.
 */
export function pruneMemoryIndex(db: TreeDb): number {
  const live = liveOwners(db)
  const alive = (kind: MemoryOwnerKind, id: string): boolean => isAlive(live, kind, id)
  const owners = db
    .select({ kind: memoryScan.ownerKind, id: memoryScan.ownerId })
    .from(memoryScan)
    .all()
  const indexed = db.all<{ source: PassageSource; owner_id: string }>(
    sql`SELECT DISTINCT source, owner_id FROM memory_passage_fts`
  )
  const goneRows = indexed.filter((row) => !alive(ownerKindOf(row.source), row.owner_id))
  const goneScans = owners.filter((row) => !alive(row.kind, row.id))
  if (goneRows.length === 0 && goneScans.length === 0) return 0
  db.transaction((tx) => {
    for (const row of goneRows) {
      tx.run(
        sql`DELETE FROM memory_passage_fts WHERE owner_id = ${row.owner_id} AND source = ${row.source}`
      )
    }
    for (const row of goneScans) deleteScanRow(tx, row.kind, row.id)
  })
  return new Set([...goneRows.map((row) => row.owner_id), ...goneScans.map((row) => row.id)]).size
}

/**
 * The paragraphs that best match `query`, best first (bm25), each labelled with its source and
 * canon status. Every word of the query is quoted (`ftsQuery`), so FTS operators in it are plain
 * words. `sources` narrows the search (none: every source but card lines); rows of an owner that
 * is gone are skipped.
 */
export function searchMemoryPassages(
  db: TreeDb,
  query: string,
  options: {
    sources?: readonly PassageSource[]
    limit?: number
    /** The project's nodes, when the caller has them (F-16.24: Step 0 reads them once). */
    nodes?: NodeRow[]
  } = {}
): MemoryPassageHit[] {
  const match = ftsQuery(query)
  const max = Math.min(Math.max(0, Math.floor(options.limit ?? 10)), MEMORY_PASSAGE_SEARCH_MAX)
  if (match === null || max === 0) return []
  const live = liveOwners(db, options.nodes)
  // Without the manuscript's scenes (most rows), the few rows of those sources are picked from
  // FTS5's content table first, so the match never reads every scene row to filter it out.
  const narrow =
    options.sources !== undefined &&
    options.sources.length > 0 &&
    !options.sources.includes('scene')
  const filter = narrow
    ? sql` AND rowid IN (SELECT id FROM memory_passage_fts_content WHERE 1${sourceFilter(
        options.sources,
        sql`c0`
      )})`
    : sourceFilter(options.sources)
  const rows = db.all<{
    source: PassageSource
    owner_id: string
    para: number
    canon: PassageCanon
    snippet: string
    rank: number
  }>(
    sql`SELECT source, owner_id, para, canon,
          snippet(memory_passage_fts, 4, '', '', '…', ${SNIPPET_TOKENS}) AS snippet,
          bm25(memory_passage_fts) AS rank
        FROM memory_passage_fts WHERE memory_passage_fts MATCH ${match}${filter}
        ORDER BY rank LIMIT ${max * 3}`
  )
  return rows
    .filter((row) => isAlive(live, ownerKindOf(row.source), row.owner_id))
    .slice(0, max)
    .map((row) => ({
      source: row.source,
      ownerId: row.owner_id,
      para: Number(row.para),
      canon: row.canon,
      label: passageLabel(row.source, row.canon),
      snippet: row.snippet,
      score: -row.rank
    }))
}

/** The SQL filter for `sources` (none: every source but the card lines, a map, F-16.18). */
function sourceFilter(sources: readonly PassageSource[] | undefined, column = sql`source`): SQL {
  const wanted = sources === undefined || sources.length === 0 ? DEFAULT_PASSAGE_SOURCES : sources
  return sql` AND ${column} IN (${sql.join(
    wanted.map((source) => sql`${source}`),
    sql`, `
  )})`
}

/** The most matches `searchMemoryPassagesInOrder` reads per word before ranking them. */
export const MEMORY_PASSAGE_PLACES_MAX = 20_000

/** What `searchMemoryPassagesInOrder` found. */
export interface OrderedPassages {
  /** The kept paragraphs, one per owner (its best), in the caller's order, with snippets. */
  hits: MemoryPassageHit[]
  /** Every matching owner's best paragraph, the kept first: what the search returned. */
  matched: { ownerId: string; para: number }[]
  /** The first and last place of the matching owners that were not kept; null when none was cut. */
  cut: { first: number; last: number } | null
}

interface Placed {
  row: { id: number; source: PassageSource; owner_id: string; para: number }
  order: number
  para: number
  /** Distinct `terms` the paragraph holds. */
  terms: number
  /** Distinct name groups it names. */
  names: number
}

/**
 * Every paragraph matching `terms` placed by the caller (F-16.25, P3-D8: a first / last / ever
 * question reads every earlier scene, not bm25's best): `orderOf` answers an owner's place, or
 * undefined to leave it out (after now, not readable). Each paragraph is ranked by how many of
 * `terms` it holds, then by whether it names any of `names` (one word list per record); with no
 * terms, by how many of the records it names. Each owner keeps its best paragraph (the earliest among equals); the
 * best `max` owners are kept, the earliest first (`latest`: the latest first), and come back in
 * the caller's order with snippets made from their text (no FTS snippets: they re-read every
 * match). `cut` says which places a full answer would also have held.
 */
export function searchMemoryPassagesInOrder(
  db: TreeDb,
  terms: readonly string[],
  options: {
    names?: readonly (readonly string[])[]
    sources?: readonly PassageSource[]
    max: number
    orderOf: (ownerId: string) => number | undefined
    latest?: boolean
    nodes?: NodeRow[]
  }
): OrderedPassages {
  const empty: OrderedPassages = { hits: [], matched: [], cut: null }
  const groups = (options.names ?? []).filter((group) => ftsQuery(group.join(' ')) !== null)
  const words = terms.filter((term) => ftsQuery(term) !== null)
  if (options.max <= 0 || (words.length === 0 && groups.length === 0)) return empty
  const live = liveOwners(db, options.nodes)
  const filter = sourceFilter(options.sources, sql`c0`)
  const places = new Map<number, Placed>()
  // One match of every word (or, with none, every name) places the paragraphs; then one rowid
  // pass per word and per record counts what each holds (rowids only: no column is read).
  const placing = words.length > 0 ? words : groups.flat()
  const first = ftsQuery(placing.join(' '))
  if (first === null) return empty
  const owners = new Map<string, number | undefined>()
  const placeOf = (row: Placed['row']): number | undefined => {
    const key = `${row.source}:${row.owner_id}`
    if (!owners.has(key)) {
      owners.set(
        key,
        isAlive(live, ownerKindOf(row.source), row.owner_id)
          ? options.orderOf(row.owner_id)
          : undefined
      )
    }
    return owners.get(key)
  }
  // The matches' places from FTS5's content table (`<table>_content`: id, then c0… in the
  // columns' order: source, owner_id, para, canon, text; documented as FTS5's shadow tables), so
  // the text is never read for a match that is only placed (half the cost of FTS's own columns).
  for (const row of db.all<Placed['row']>(
    sql`SELECT id, c0 AS source, c1 AS owner_id, c2 AS para FROM memory_passage_fts_content
        WHERE id IN (SELECT rowid FROM memory_passage_fts WHERE memory_passage_fts MATCH ${first}
          LIMIT ${MEMORY_PASSAGE_PLACES_MAX})${filter}`
  )) {
    const order = placeOf(row)
    if (order === undefined) continue
    places.set(Number(row.id), { row, order, para: Number(row.para), terms: 0, names: 0 })
  }
  const count = (query: string, add: (placed: Placed) => void): void => {
    const match = ftsQuery(query)
    if (match === null) return
    for (const { id } of db.all<{ id: number }>(
      sql`SELECT rowid AS id FROM memory_passage_fts WHERE memory_passage_fts MATCH ${match}
          LIMIT ${MEMORY_PASSAGE_PLACES_MAX}`
    )) {
      const placed = places.get(Number(id))
      if (placed !== undefined) add(placed)
    }
  }
  if (words.length === 1) for (const placed of places.values()) placed.terms = 1
  else for (const word of words) count(word, (placed) => void (placed.terms += 1))
  // With words, a name only breaks a tie (one pass: does it name any of them); with none, the
  // names are the ranking (one pass per record: how many it names).
  if (words.length > 0 && groups.length > 0) {
    count(groups.flat().join(' '), (placed) => void (placed.names = 1))
  } else {
    for (const group of groups) count(group.join(' '), (placed) => void (placed.names += 1))
  }
  // Each owner's best paragraph: the most terms, then names, then the earliest.
  const better = (a: Placed, b: Placed): number =>
    b.terms - a.terms || b.names - a.names || a.para - b.para
  const best = new Map<string, Placed>()
  for (const placed of places.values()) {
    const held = best.get(placed.row.owner_id)
    if (held === undefined || better(placed, held) < 0) best.set(placed.row.owner_id, placed)
  }
  const ranked = [...best.values()].sort(
    (a, b) =>
      b.terms - a.terms ||
      b.names - a.names ||
      (options.latest === true ? b.order - a.order : a.order - b.order)
  )
  const kept = ranked.slice(0, options.max).sort((a, b) => a.order - b.order || a.para - b.para)
  const left = ranked.slice(options.max).map((placed) => placed.order)
  if (kept.length === 0) return empty
  // The kept rows' text and canon by rowid (no second MATCH: FTS snippets re-read every match).
  const texts = new Map(
    db
      .all<{ id: number; text: string; canon: PassageCanon }>(
        sql`SELECT rowid AS id, text, canon FROM memory_passage_fts WHERE rowid IN (${sql.join(
          kept.map((each) => sql`${each.row.id}`),
          sql`, `
        )})`
      )
      .map((row) => [Number(row.id), row])
  )
  const around = placing.flatMap(
    (word) =>
      word
        .normalize('NFC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
  )
  return {
    hits: kept.flatMap(({ row, para, order }) => {
      const stored = texts.get(Number(row.id))
      if (stored === undefined) return []
      return [
        {
          source: row.source,
          ownerId: row.owner_id,
          para,
          canon: stored.canon,
          label: passageLabel(row.source, stored.canon),
          snippet: snippetAround(stored.text, around),
          // Reading order, not relevance: the earliest place scores highest.
          score: -order
        }
      ]
    }),
    matched: [...kept, ...ranked.slice(options.max)].map((placed) => ({
      ownerId: placed.row.owner_id,
      para: placed.para
    })),
    cut: left.length === 0 ? null : { first: Math.min(...left), last: Math.max(...left) }
  }
}

/**
 * Whether the index matches this paragraph of `ownerId` for any of `terms`, as every search here
 * matches (`ftsQuery`): the search-miss log's test (P3-D15, slice 6 review). A paragraph FTS
 * places but a ranking leaves out (the ordered search keeps one paragraph a scene) was found, so
 * it is never logged as something FTS and the navigator's synonyms missed. One query per widened
 * citation, so the cost is a match of the terms.
 */
export function passageMatches(
  db: TreeDb,
  terms: readonly string[],
  ownerId: string,
  para: number
): boolean {
  const match = ftsQuery(terms.join(' '))
  if (match === null) return false
  return (
    db.all<{ id: number }>(
      sql`SELECT rowid AS id FROM memory_passage_fts WHERE memory_passage_fts MATCH ${match}
          AND owner_id = ${ownerId} AND para = ${para} LIMIT 1`
    ).length > 0
  )
}

/**
 * About `SNIPPET_TOKENS` words of `text` around the first word one of `terms` starts ("counted"
 * for "count"), or that starts one of them as a stem does (the index stems words: "count" for
 * "counted"; four letters at least and at most three fewer, so "to" is no hit for "tomas"), `…`
 * where it was cut.
 */
export function snippetAround(text: string, terms: readonly string[]): string {
  const tokens = [...text.matchAll(/\S+/gu)]
  if (tokens.length <= SNIPPET_TOKENS) return text.replace(/\s+/g, ' ').trim()
  const hit = tokens.findIndex((token) => {
    const word = token[0].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    // The index stems words ("counted" for "count"): a shorter word is a hit only as a stem.
    return (
      word !== '' &&
      terms.some(
        (term) =>
          word.startsWith(term) ||
          (word.length >= 4 && term.length - word.length <= 3 && term.startsWith(word))
      )
    )
  })
  const from = Math.max(
    0,
    Math.min((hit < 0 ? 0 : hit) - Math.floor(SNIPPET_TOKENS / 2), tokens.length - SNIPPET_TOKENS)
  )
  const kept = tokens.slice(from, from + SNIPPET_TOKENS).map((token) => token[0])
  return `${from > 0 ? '…' : ''}${kept.join(' ')}${from + SNIPPET_TOKENS < tokens.length ? '…' : ''}`
}
