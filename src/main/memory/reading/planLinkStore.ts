import { eq } from 'drizzle-orm'
import { readerMayRead } from '@shared/memory/sources'
import { PLAN_LINKS_REASON_MAX, type AiPlanLink, type PlanLinkView } from '@shared/planLinks'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import { planLink, type NodeRow, type PlanLinkRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { claimSources } from './claimStore'

/**
 * The store of story memory v2's automatic plan links (F-16.21): the one owner of `plan_link`,
 * which holds the links code or `planLinks.v2` made (never the author's, which stay in
 * `SceneMeta.fulfilledBy`). A link stands while it was made in the active draft (design §2.2:
 * only the active draft's rows are live), its plan is still planned (no words) and not linked by
 * the author, and its scene is drafted and readable (an Idea scene or one left out of compile
 * never happened, so it fulfils nothing); the views read only what stands, and the matcher
 * (`planLinks.ts`) drops the rest. No AI here, so the story map can read it.
 */

export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** The manuscript as plan links see it: documents in reading order with their metadata. */
export interface Board {
  docs: NodeRow[]
  metaOf: Map<string, SceneMeta>
  byId: Map<string, NodeRow>
  /** Whether a scene is read at all (not an Idea, not left out of compile). */
  readable: (nodeId: string) => boolean
}

export function boardOf(db: TreeDb): Board {
  const docs = manuscriptDocuments(db)
  const sourceOf = claimSources(db, docs)
  return {
    docs,
    metaOf: new Map(docs.map((row) => [row.id, parseStoredSceneMeta(row.sceneMeta)])),
    byId: new Map(docs.map((row) => [row.id, row])),
    readable: (nodeId) => readerMayRead(sourceOf(nodeId))
  }
}

export const isPlanned = (row: NodeRow | undefined): boolean => row?.wordCount === 0
export const isDrafted = (row: NodeRow | undefined): boolean => (row?.wordCount ?? 0) > 0

/** The author's own link of a planned scene, when it points at a scene that exists. */
export function authorLink(board: Board, planId: string): string | null {
  const by = board.metaOf.get(planId)?.fulfilledBy
  return by !== undefined && board.byId.has(by) ? by : null
}

export function planLinkRows(db: TreeDb): PlanLinkRow[] {
  return db.select().from(planLink).all()
}

/**
 * Whether a stored link still stands: made in the active draft (`draftId`), its plan still planned
 * and not the author's, its scene drafted and readable.
 */
export function stands(board: Board, row: PlanLinkRow, draftId: string | null): boolean {
  return (
    draftId !== null &&
    row.draftId === draftId &&
    isPlanned(board.byId.get(row.planId)) &&
    authorLink(board, row.planId) === null &&
    isDrafted(board.byId.get(row.sceneId)) &&
    board.readable(row.sceneId)
  )
}

const toView = (row: PlanLinkRow): AiPlanLink => ({
  planId: row.planId,
  sceneId: row.sceneId,
  origin: row.origin,
  reason: clip(row.reason, PLAN_LINKS_REASON_MAX)
})

/** The links applied automatically that still stand, in reading order of their plans. */
export function livePlanLinks(db: TreeDb): AiPlanLink[] {
  const board = boardOf(db)
  const draftId = currentDraftId(db)
  const order = new Map(board.docs.map((row, i) => [row.id, i]))
  return planLinkRows(db)
    .filter((row) => stands(board, row, draftId))
    .sort((a, b) => (order.get(a.planId) ?? 0) - (order.get(b.planId) ?? 0))
    .map(toView)
}

/** What the Outline reads in v2 (`planLinks:get`): the automatic links; nothing waits for a confirm. */
export function planLinkViewV2(db: TreeDb): PlanLinkView {
  return { suggestions: [], aiApplied: [], aiLinks: livePlanLinks(db) }
}

/**
 * Deletes the active draft's links that no longer stand, and any made before links had a draft;
 * another draft's links wait for that draft (a link made here replaces one of them for the same
 * plan). Answers how many went.
 */
export function prune(db: TreeDb, board: Board, draftId: string): number {
  let gone = 0
  for (const row of planLinkRows(db)) {
    if (row.draftId !== null && (row.draftId !== draftId || stands(board, row, draftId))) continue
    deleteLink(db, row.planId)
    gone += 1
  }
  return gone
}

export function deleteLink(db: TreeDb, planId: string): void {
  db.delete(planLink).where(eq(planLink.planId, planId)).run()
}

/** Writes a link (replacing the plan's link, if any). */
export function insertLink(db: TreeDb, row: PlanLinkRow): void {
  db.insert(planLink).values(row).onConflictDoUpdate({ target: planLink.planId, set: row }).run()
}
