import { and, eq, inArray } from 'drizzle-orm'
import type { BackfillState } from '@shared/memory/claims'
import { normName } from '@shared/memory/names'
import { readerMayRead } from '@shared/memory/sources'
import { planWindows } from '@shared/memory/windows'
import { memoryBackfill, sceneRead } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { claimSources } from './claimStore'
import { loadReadingScene, namingParas } from './readerContext'

/**
 * The lazy back-fill (F-16.17; design §2.3 "Invalidation", plan P2a §3.4): a record made, or a
 * nickname added, after scenes that name it were read leaves those scenes' facts about it unread
 * (names are out of the gate's hashes, so the gate never sees a change). One `memory_backfill` row
 * per record and name, made once, holds how many pages reading it back would take: the paragraphs
 * naming it ±2 in the active draft's scenes read before. Up to 3 pages are read without asking
 * (counted against the Cloud cap); more are asked about with the price. The row ends `done` or
 * `declined`, so a back-fill runs once.
 */

/** Up to this many pages are read without asking. */
export const BACKFILL_UNASKED_PAGES = 3

/** One scene of a back-fill: the paragraphs that name the record by that name, and their pages. */
export interface BackfillScene {
  nodeId: string
  paras: number[]
  pages: number
}

/** The scenes of the active draft read before whose paragraphs name `recordId` by `norm`. */
export function backfillPlan(db: TreeDb, recordId: string, norm: string): BackfillScene[] {
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const read = new Set(
    db
      .select({ nodeId: sceneRead.nodeId })
      .from(sceneRead)
      .where(eq(sceneRead.draftId, draftId))
      .all()
      .map((row) => row.nodeId)
  )
  const sourceOf = claimSources(db)
  const plan: BackfillScene[] = []
  for (const row of manuscriptDocuments(db)) {
    if (!read.has(row.id) || !readerMayRead(sourceOf(row.id))) continue
    const scene = loadReadingScene(db, row.id)
    if (scene === null) continue
    const paras = [
      ...new Set(
        scene.mentions
          .filter(
            (mention) =>
              mention.recordId === recordId && !mention.ambiguous && normName(mention.text) === norm
          )
          .map((mention) => mention.para)
      )
    ].sort((a, b) => a - b)
    if (paras.length === 0) continue
    const pieces = planWindows(scene.texts, paras, namingParas(scene))
    plan.push({ nodeId: row.id, paras, pages: pieces.length })
  }
  return plan
}

/**
 * Notes the names a record gained (made, or given nicknames): one row per name it has none for,
 * `due` with its pages, or `done` at once when no scene read before names it. Answers the norms
 * that now wait to be read.
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
  const due: string[] = []
  for (const norm of norms) {
    if (known.has(norm)) continue
    const pages = backfillPlan(db, recordId, norm).reduce((sum, scene) => sum + scene.pages, 0)
    db.insert(memoryBackfill)
      .values({
        recordId,
        norm,
        state: pages === 0 ? 'done' : 'due',
        pages,
        created: now.toISOString(),
        doneAt: pages === 0 ? now.toISOString() : null
      })
      .run()
    if (pages > 0) due.push(norm)
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
