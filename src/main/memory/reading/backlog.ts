import { eq } from 'drizzle-orm'
import { estimateTokens } from '@shared/ai'
import type { ReadDecision } from '@shared/memory/gate'
import { readerMayRead } from '@shared/memory/sources'
import type { RebuildEstimate } from '@shared/memory/switchover'
import { planPages, planWindows } from '@shared/memory/windows'
import { READER_V3_PAGE_TOKENS } from '../../ai/prompts/reader.v3'
import { sceneRead } from '../../db/schema'
import { estimateCost } from '../../knowledge/conversion'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, documentText, manuscriptDocuments } from '../../voice/profile'
import { estimateRebuild, plannedRow, type RebuildContext } from '../switchover/plan'
import { claimSources } from './claimStore'
import { gateScene } from './pipeline'
import { namingParas, readBook, type Book } from './readerContext'

/**
 * What is left to read (F-16.16; design §2.3 "Changes made outside the editor", plan P2a §3.3):
 * the scenes of the active draft whose gate says something changed, how much each would send, and
 * what reading them would cost. Local and free: the reader service asks it after a bulk write
 * (Replace in project, a revert, a draft switch, the chat's bulk tools, an accepted edit pass) and
 * on every open, and queues up to 5 scenes or asks with the price.
 */

/** Up to this many changed scenes are read without asking. */
export const BACKLOG_UNASKED = 5

/** A scene the gate would read now. */
export interface DueScene {
  nodeId: string
  read: 'window' | 'full'
  /** The prose tokens it would send (the window's pieces, or the whole scene). */
  proseTokens: number
}

/** The gate's answer as a due scene, or null when it reads nothing. */
function asDue(db: TreeDb, nodeId: string, book: Book): DueScene | null {
  const gate = gateScene(db, nodeId, null, book)
  if (gate === null || gate.decision.read === 'nothing') return null
  const decision: Exclude<ReadDecision, { read: 'nothing' }> = gate.decision
  const pieces =
    decision.read === 'full'
      ? planPages(gate.scene.texts)
      : planWindows(gate.scene.texts, decision.paras, namingParas(gate.scene))
  return {
    nodeId,
    read: decision.read,
    proseTokens: pieces.reduce((sum, piece) => sum + piece.tokens, 0)
  }
}

/**
 * The readable scenes of the active draft the gate would read now (no caret: nobody is typing
 * in them), in reading order; `only` limits the walk to those scenes.
 */
export function dueScenes(db: TreeDb, only?: ReadonlySet<string>): DueScene[] {
  const due: DueScene[] = []
  // One read of the book for the whole walk (the tree, the roster, every scene's words).
  const book = readBook(db)
  for (const row of book.rows) {
    if (only !== undefined && !only.has(row.id)) continue
    const scene = asDue(db, row.id, book)
    if (scene !== null) due.push(scene)
  }
  return due
}

/** Whether any scene of this draft was ever read (a draft never read is priced like a rebuild). */
export function draftEverRead(db: TreeDb, draftId: string): boolean {
  return (
    db.select().from(sceneRead).where(eq(sceneRead.draftId, draftId)).limit(1).get() !== undefined
  )
}

/** The readable scenes of the active draft with text, each with its prose tokens (*Rebuild memory*). */
export function readableScenes(db: TreeDb): { nodeId: string; proseTokens: number }[] {
  const rows = manuscriptDocuments(db)
  const sourceOf = claimSources(db, rows)
  return rows
    .filter((row) => readerMayRead(sourceOf(row.id)) && documentJson(row) !== null)
    .map((row) => ({ nodeId: row.id, proseTokens: estimateTokens(documentText(row)) }))
    .filter((scene) => scene.proseTokens > 0)
}

/**
 * *Rebuild memory*'s price over the active draft (P1's `estimateRebuild`, now over shipped rows);
 * `sweepCalls` (F-16.27) prices the contradiction sweep it ends with, when the switch is on.
 */
export function rebuildEstimate(
  db: TreeDb,
  context: RebuildContext,
  sweepCalls?: (scenes: number) => number
): RebuildEstimate {
  const scenes = readableScenes(db).map((scene) => scene.proseTokens)
  return estimateRebuild(scenes, context, sweepCalls?.(scenes.length) ?? 0)
}

/**
 * What reading these scenes would cost now (`reader.v6`'s sizes, plan `ReaderNarrow.md`,
 * 2026-10-14, kept by plan `Suggestions.md` 2026-10-15): a window read as `reader.v6:window` and one check batch (`verify.v4`) per piece of
 * 400 prose tokens, a full read as `reader.v6:first` per page of 400 prose tokens and a check batch
 * per page; on the fast model, at the hosted quote on Cloud, free on a local model.
 */
export function priceReads(
  scenes: readonly Pick<DueScene, 'read' | 'proseTokens'>[],
  context: RebuildContext
): { costUsd: number; priced: boolean } {
  const first = plannedRow('reader.v6:first')
  const window = plannedRow('reader.v6:window')
  const verify = plannedRow('verify.v4')
  const pageOverhead = first.typicalInTokens - READER_V3_PAGE_TOKENS
  let tokensIn = 0
  let tokensOut = 0
  for (const scene of scenes) {
    const pages = Math.max(1, Math.ceil(scene.proseTokens / READER_V3_PAGE_TOKENS))
    if (scene.read === 'window') {
      tokensIn += pages * (window.typicalInTokens + verify.typicalInTokens)
      tokensOut += pages * (window.typicalOutTokens + verify.typicalOutTokens)
      continue
    }
    tokensIn += scene.proseTokens + pages * (pageOverhead + verify.typicalInTokens)
    tokensOut += pages * (first.typicalOutTokens + verify.typicalOutTokens)
  }
  return estimateCost(
    { source: context.source, model: context.fastModel, pricing: context.pricing },
    tokensIn,
    tokensOut
  )
}
