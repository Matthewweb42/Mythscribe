import { and, eq, inArray } from 'drizzle-orm'
import { passageParagraphs } from '@shared/mentions'
import type { BackfillState } from '@shared/memory/claims'
import { normName } from '@shared/memory/names'
import { readerMayRead } from '@shared/memory/sources'
import { planWindows } from '@shared/memory/windows'
import { EMPTY_DOC } from '@shared/tiptap'
import { memoryBackfill, sceneRead } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson } from '../../voice/profile'
import { loadReadingScene, namingParas, readBook, type Book, type ReadingScene } from './readerContext'

/**
 * The lazy back-fill (F-16.17; design §2.3 "Invalidation", plan P2a §3.4): a record made, or a
 * nickname added, after scenes that name it were read leaves those scenes' facts about it unread
 * (names are out of the gate's hashes, so the gate never sees a change). One `memory_backfill` row
 * per record and name, made once, holds how many pages reading it back would take: the paragraphs
 * naming it ±2 in the active draft's scenes read before. Up to 3 pages per record (all its names
 * together, `backfillsByRecord`) are read without asking (counted against the Cloud cap); more
 * are asked about with the price. The row ends `done` or `declined`, so a back-fill runs once.
 */

/** Up to this many pages are read without asking. */
export const BACKFILL_UNASKED_PAGES = 3

/** One scene of a back-fill: the paragraphs that name the record by that name, and their pages. */
export interface BackfillScene {
  nodeId: string
  paras: number[]
  pages: number
}

/** A scene read before that names a record: the paragraphs naming it, by name. */
interface Naming {
  nodeId: string
  scene: ReadingScene
  paras: Map<string, number[]>
}

/**
 * The scenes of the active draft read before whose paragraphs name `recordId` by one of `norms`,
 * in reading order. A scene whose text holds none of the names (folded as `normName` folds them,
 * so a name in it is a substring) is skipped before its name scan.
 */
function namings(db: TreeDb, recordId: string, norms: readonly string[], book: Book): Naming[] {
  const draftId = currentDraftId(db)
  if (draftId === null || norms.length === 0) return []
  const wanted = new Set(norms)
  const read = new Set(
    db
      .select({ nodeId: sceneRead.nodeId })
      .from(sceneRead)
      .where(eq(sceneRead.draftId, draftId))
      .all()
      .map((row) => row.nodeId)
  )
  const found: Naming[] = []
  for (const row of book.rows) {
    if (!read.has(row.id) || !readerMayRead(book.sourceOf(row.id))) continue
    const folded = normName(
      passageParagraphs(documentJson(row) ?? EMPTY_DOC)
        .map((paragraph) => paragraph.text)
        .join('\n')
    )
    if (!norms.some((norm) => folded.includes(norm))) continue
    const scene = loadReadingScene(db, row.id, book)
    if (scene === null) continue
    const paras = new Map<string, number[]>()
    for (const mention of scene.mentions) {
      if (mention.recordId !== recordId || mention.ambiguous) continue
      const norm = normName(mention.text)
      if (!wanted.has(norm)) continue
      const list = paras.get(norm) ?? []
      if (!list.includes(mention.para)) list.push(mention.para)
      paras.set(norm, list)
    }
    if (paras.size > 0) found.push({ nodeId: row.id, scene, paras })
  }
  return found
}

/** The pages reading these paragraphs ±2 of a scene takes (`planWindows`). */
function pagesOf(scene: ReadingScene, paras: readonly number[]): number {
  return planWindows(scene.texts, [...paras].sort((a, b) => a - b), namingParas(scene)).length
}

/**
 * The scenes of the active draft read before whose paragraphs name `recordId` by one of `norms`
 * (a record's names merged: a paragraph naming it twice is read once). `book` shares one read of
 * the manuscript across several calls.
 */
export function backfillPlan(
  db: TreeDb,
  recordId: string,
  norms: readonly string[],
  book: Book = readBook(db)
): BackfillScene[] {
  return namings(db, recordId, norms, book).map(({ nodeId, scene, paras }) => {
    const all = [...new Set([...paras.values()].flat())].sort((a, b) => a - b)
    return { nodeId, paras: all, pages: pagesOf(scene, all) }
  })
}

/**
 * Notes the names a record gained (made, or given nicknames): one row per name it has none for,
 * `due` with its pages, or `done` at once when no scene read before names it. Answers the norms
 * that now wait to be read. The scenes are walked once for all the names.
 */
export function noteLateNames(
  db: TreeDb,
  recordId: string,
  names: readonly string[],
  now: Date
): string[] {
  const norms = [...new Set(names.map(normName).filter((norm) => norm !== ''))]
  if (norms.length === 0) return []
  const known = new Set(
    db
      .select({ norm: memoryBackfill.norm })
      .from(memoryBackfill)
      .where(and(eq(memoryBackfill.recordId, recordId), inArray(memoryBackfill.norm, norms)))
      .all()
      .map((row) => row.norm)
  )
  const fresh = norms.filter((norm) => !known.has(norm))
  const pages = new Map(fresh.map((norm) => [norm, 0]))
  for (const { scene, paras } of namings(db, recordId, fresh, readBook(db))) {
    for (const [norm, list] of paras) pages.set(norm, (pages.get(norm) ?? 0) + pagesOf(scene, list))
  }
  const due: string[] = []
  for (const norm of fresh) {
    const count = pages.get(norm) ?? 0
    db.insert(memoryBackfill)
      .values({
        recordId,
        norm,
        state: count === 0 ? 'done' : 'due',
        pages: count,
        created: now.toISOString(),
        doneAt: count === 0 ? now.toISOString() : null
      })
      .run()
    if (count > 0) due.push(norm)
  }
  return due
}

/** A back-fill row still to run or ask about. */
export interface OpenBackfill {
  recordId: string
  norm: string
  state: Extract<BackfillState, 'due' | 'asked'>
  pages: number
}

/** Every back-fill `due` (not yet asked about or queued) or `asked` (confirmed with its price). */
export function openBackfills(db: TreeDb): OpenBackfill[] {
  return db
    .select()
    .from(memoryBackfill)
    .where(inArray(memoryBackfill.state, ['due', 'asked']))
    .all()
    .flatMap((row) =>
      row.state === 'due' || row.state === 'asked'
        ? [{ recordId: row.recordId, norm: row.norm, state: row.state, pages: row.pages }]
        : []
    )
}

/** One record's open back-fills: the rows still `due`, the rows `asked`, the due rows' pages. */
export interface RecordBackfill {
  recordId: string
  due: OpenBackfill[]
  asked: OpenBackfill[]
  duePages: number
  /**
   * Whether its due rows wait for the author: over 3 pages together (counted per record, so
   * a record's names never slip under the line one by one).
   */
  ask: boolean
}

/** The open back-fills by record, in the order they come (the one rule both the notice and the run read). */
export function backfillsByRecord(rows: readonly OpenBackfill[]): RecordBackfill[] {
  const byRecord = new Map<string, RecordBackfill>()
  for (const row of rows) {
    const entry = byRecord.get(row.recordId) ?? {
      recordId: row.recordId,
      due: [],
      asked: [],
      duePages: 0,
      ask: false
    }
    if (row.state === 'due') {
      entry.due.push(row)
      entry.duePages += row.pages
    } else entry.asked.push(row)
    entry.ask = entry.duePages > BACKFILL_UNASKED_PAGES
    byRecord.set(row.recordId, entry)
  }
  return [...byRecord.values()]
}

/** Moves a record's open back-fills (or the one for `norm`) to `state`. */
export function setBackfillState(
  db: TreeDb,
  recordId: string,
  state: BackfillState,
  now: Date,
  norm?: string
): void {
  const ended = state === 'done' || state === 'declined'
  db.update(memoryBackfill)
    .set({ state, ...(ended ? { doneAt: now.toISOString() } : {}) })
    .where(
      and(
        eq(memoryBackfill.recordId, recordId),
        inArray(memoryBackfill.state, ['due', 'asked']),
        ...(norm === undefined ? [] : [eq(memoryBackfill.norm, norm)])
      )
    )
    .run()
}
