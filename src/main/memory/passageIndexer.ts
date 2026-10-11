import { asc, eq, sql } from 'drizzle-orm'
import { passageParagraphs } from '@shared/mentions'
import { markedParagraphs } from '@shared/memory/pageMarks'
import {
  MEMORY_PASSAGE_SEARCH_MAX,
  passageLabel,
  type MemoryOwnerKind,
  type MemoryPassageHit,
  type PassageCanon,
  type PassageSource
} from '@shared/memory/passages'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import { memoryScan, record, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getCompileState } from '../project/settingsStore'
import { ftsQuery } from '../search/passageIndex'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { deleteScanRow, getScanHashes, scanHashesOf, setScanHash } from './scanStore'

/**
 * The passage index of story memory v2 (F-16.5): the one writer of `memory_passage_fts`
 * (migration 0031, a virtual table drizzle does not model, so it is read and written with plain
 * SQL). One row per paragraph with text, labelled by source and canon status:
 * - a scene's paragraphs are `scene`, or `ideaScene` when it (or a folder above it) has the Idea
 *   status, or `excludedScene` when it is left out of compile;
 * - a scene's notes are `sceneNote`;
 * - a record's Pinned paragraphs are `pinned` and its Ideas `idea`, each `notCanon` where marked;
 * - Research pages arrive with P1 slice 2.
 * An owner is skipped while its rows hash as they did (`memory_scan.passages_hash`). Local and
 * free; nothing leaves the machine.
 */

/** Bumped when what goes into the index changes, so every owner is written again. */
export const MEMORY_PASSAGE_INDEX_VERSION = 1

/** Tokens of context `snippet()` keeps around the match. */
const SNIPPET_TOKENS = 16

interface PassageRow {
  source: PassageSource
  para: number
  canon: PassageCanon
  text: string
}

const SOURCES_OF: Record<Exclude<MemoryOwnerKind, 'research'>, readonly PassageSource[]> = {
  scene: ['scene', 'ideaScene', 'excludedScene'],
  sceneNote: ['sceneNote'],
  record: ['pinned', 'idea']
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

/** The page's rows under one source, Not canon where marked. */
function pageRows(doc: TiptapNodeT | null, source: PassageSource): PassageRow[] {
  if (doc === null) return []
  return markedParagraphs(doc).map((paragraph) => ({
    source,
    para: paragraph.index,
    canon: paragraph.notCanon ? 'notCanon' : 'canon',
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
    canon: 'canon',
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
  kind: Exclude<MemoryOwnerKind, 'research'>,
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
  kind: Exclude<MemoryOwnerKind, 'research'>,
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
 * Indexes one owner: a scene's text (`scene`), a scene's notes (`sceneNote`), or a record's
 * pages (`record`). A scene that is not a manuscript document, or a record that is gone, throws
 * NOT_FOUND (quiet for the queue). Research pages have no owner before P1 slice 2.
 */
export function indexOwner(db: TreeDb, kind: MemoryOwnerKind, id: string, now: Date): boolean {
  if (kind === 'record') {
    const rows = recordRows(db, id)
    if (rows === null) throw new AppError('NOT_FOUND', 'That record no longer exists', { id })
    return writeOwner(db, 'record', id, rows, now)
  }
  if (kind === 'research') {
    throw new AppError('NOT_FOUND', 'This project has no Research section yet', { id })
  }
  const nodes = listNodes(db)
  const row = manuscriptDocuments(db, nodes).find((document) => document.id === id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Not a manuscript document', { id })
  if (kind === 'sceneNote') return writeOwner(db, 'sceneNote', id, noteRows(row), now)
  return writeOwner(db, 'scene', id, sceneRows(row, sceneStatuses(db, nodes)), now)
}

/** A scene's text and its notes, as one `passages` job does. */
export function indexScene(db: TreeDb, nodeId: string, now: Date): boolean {
  const text = indexOwner(db, 'scene', nodeId, now)
  const notes = indexOwner(db, 'sceneNote', nodeId, now)
  return text || notes
}

/** One owner the index is behind on. */
export interface StaleOwner {
  kind: Exclude<MemoryOwnerKind, 'research'>
  id: string
}

/** Every owner whose rows would read differently now: scenes (and notes) in reading order, then records. */
export function stalePassageOwners(db: TreeDb): StaleOwner[] {
  const nodes = listNodes(db)
  const statuses = sceneStatuses(db, nodes)
  const scenes = scanHashesOf(db, 'scene')
  const notes = scanHashesOf(db, 'sceneNote')
  const records = scanHashesOf(db, 'record')
  const stale: StaleOwner[] = []
  for (const row of manuscriptDocuments(db, nodes)) {
    if (scenes.get(row.id)?.passagesHash !== rowsHash(sceneRows(row, statuses))) {
      stale.push({ kind: 'scene', id: row.id })
    }
    if (notes.get(row.id)?.passagesHash !== rowsHash(noteRows(row))) {
      stale.push({ kind: 'sceneNote', id: row.id })
    }
  }
  for (const { id } of db
    .select({ id: record.id })
    .from(record)
    .orderBy(asc(record.created))
    .all()) {
    if (records.get(id)?.passagesHash !== rowsHash(recordRows(db, id) ?? [])) {
      stale.push({ kind: 'record', id })
    }
  }
  return stale
}

/** Indexes every stale record page (the `passages` job keyed to the manuscript root). */
export function indexStaleRecords(db: TreeDb, now: Date): number {
  let written = 0
  for (const owner of stalePassageOwners(db)) {
    if (owner.kind === 'record' && indexOwner(db, 'record', owner.id, now)) written += 1
  }
  return written
}

/** Drops an owner's rows and its hashes (a record deleted). */
export function dropOwner(
  db: TreeDb,
  kind: Exclude<MemoryOwnerKind, 'research'>,
  id: string
): void {
  db.transaction((tx) => {
    replaceRows(tx, kind, id, [])
    deleteScanRow(tx, kind, id)
  })
}

/**
 * Drops the rows and scan hashes of every owner that is gone (a scene deleted or moved out of
 * the manuscript, a record deleted), so one that comes back is indexed afresh. Runs on open.
 * Answers how many owners went.
 */
export function pruneMemoryIndex(db: TreeDb): number {
  const scenes = new Set(manuscriptDocuments(db).map((row) => row.id))
  const records = new Set(
    db
      .select({ id: record.id })
      .from(record)
      .all()
      .map((row) => row.id)
  )
  const alive = (kind: MemoryOwnerKind, id: string): boolean =>
    kind === 'record' ? records.has(id) : kind === 'research' ? false : scenes.has(id)
  const owners = db
    .select({ kind: memoryScan.ownerKind, id: memoryScan.ownerId })
    .from(memoryScan)
    .all()
  const indexed = db.all<{ source: PassageSource; owner_id: string }>(
    sql`SELECT DISTINCT source, owner_id FROM memory_passage_fts`
  )
  const ownerKind = (source: PassageSource): MemoryOwnerKind =>
    source === 'pinned' || source === 'idea'
      ? 'record'
      : source === 'sceneNote'
        ? 'sceneNote'
        : source === 'note' || source === 'research'
          ? 'research'
          : 'scene'
  const goneRows = indexed.filter((row) => !alive(ownerKind(row.source), row.owner_id))
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
 * words. `sources` narrows the search; rows of an owner that is gone are skipped.
 */
export function searchMemoryPassages(
  db: TreeDb,
  query: string,
  options: { sources?: readonly PassageSource[]; limit?: number } = {}
): MemoryPassageHit[] {
  const match = ftsQuery(query)
  const max = Math.min(Math.max(0, Math.floor(options.limit ?? 10)), MEMORY_PASSAGE_SEARCH_MAX)
  if (match === null || max === 0) return []
  const scenes = new Set(manuscriptDocuments(db).map((row) => row.id))
  const records = new Set(
    db
      .select({ id: record.id })
      .from(record)
      .all()
      .map((row) => row.id)
  )
  const sources = options.sources ?? null
  const filter =
    sources === null || sources.length === 0
      ? sql``
      : sql` AND source IN (${sql.join(
          sources.map((source) => sql`${source}`),
          sql`, `
        )})`
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
    .filter((row) =>
      row.source === 'pinned' || row.source === 'idea'
        ? records.has(row.owner_id)
        : scenes.has(row.owner_id)
    )
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
