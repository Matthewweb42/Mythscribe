import type { UnderlineMode } from '@shared/aiSettings'
import type { Finding } from '@shared/memory/findings'
import { pickUnderlines, type UnderlinesByScene } from '@shared/memory/underlines'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { nameScanShared } from '../nameIndexer'
import { unreadParagraphs } from '../reading/views'
import { findingsFrame, sideInputs } from './candidateInputs'
import { findingsOf, markShown } from './findingStore'
import { findingView } from './findingViews'
import { judgeContext } from './judge'
import { logShownScenes } from './underlineLog'

/**
 * The editor's contradiction underlines (F-16.28; design §2.4 "Underlines", plan P4 §5.1, P4-D15):
 * for each asked scene, the active draft's open findings with a book quote (a line or a character
 * on the page) in it, resolved against the text as it is now, picked by `pickUnderlines` (rule
 * order, then the newest; at most 3 marks; never in a paragraph with a finished sentence not read
 * yet). The editor draws them as decorations only. None while the Contradiction check is off
 * (P4-D21) or contradictions show in the panel only.
 *
 * One call answers every region of a stacked view (P4 slice 5 review): the open findings are read
 * once, a scene with none costs nothing more, and the sides are resolved against a context built
 * once over only those findings' claims and cards (`sideInputs`), never the whole book's. Local
 * and free.
 */
export function underlinesOf(
  db: TreeDb,
  nodeIds: readonly string[],
  options: { on: boolean; mode: UnderlineMode }
): UnderlinesByScene {
  const out: UnderlinesByScene = Object.fromEntries(nodeIds.map((nodeId) => [nodeId, []]))
  if (!options.on || options.mode === 'panel' || nodeIds.length === 0) return out
  const draftId = currentDraftId(db)
  if (draftId === null) return out
  const asked = new Set(nodeIds)
  const byScene = new Map<string, Finding[]>()
  for (const finding of findingsOf(db, draftId, ['open'])) {
    const scenes = new Set(
      [finding.a, finding.b].flatMap((side) =>
        side.kind !== 'note' && asked.has(side.nodeId) ? [side.nodeId] : []
      )
    )
    for (const nodeId of scenes) byScene.set(nodeId, [...(byScene.get(nodeId) ?? []), finding])
  }
  if (byScene.size === 0) return out
  const frame = findingsFrame(db)
  const shown = [...new Set([...byScene.values()].flat())]
  const ctx = judgeContext(
    db,
    draftId,
    frame,
    sideInputs(
      db,
      draftId,
      shown.flatMap((finding) => [finding.a, finding.b]),
      frame
    )
  )
  const rows = new Map(frame.nodes.map((row) => [row.id, row]))
  const names = nameScanShared(db).index
  for (const [nodeId, findings] of byScene) {
    const row = rows.get(nodeId)
    if (row === undefined || !frame.reading.order.has(nodeId)) continue
    const views = findings.flatMap((finding) => {
      const view = findingView(ctx, finding)
      return view === null ? [] : [{ finding: view, created: finding.created }]
    })
    if (views.length === 0) continue
    // Only the paragraphs a quote of this scene sits in are gated.
    const paras = new Set(
      views.flatMap(({ finding }) =>
        [finding.a, finding.b].flatMap((side) =>
          side.kind !== 'note' && side.nodeId === nodeId && side.para !== null ? [side.para] : []
        )
      )
    )
    out[nodeId] = pickUnderlines(views, nodeId, {
      unreadParas: unreadParagraphs(db, row, draftId, paras, names)
    }).map((mark) => ({
      findingId: mark.findingId,
      side: mark.side,
      para: mark.para,
      quote: mark.quote,
      finding: mark.finding
    }))
  }
  return out
}

/**
 * The editor drew these findings (`memory:underlinesShown`): each one's `shown_at`, once, and its
 * book sides' scene texts as they read then (what a later fix in the text is measured against).
 */
export function underlinesShown(db: TreeDb, findingIds: readonly string[], now: Date): void {
  const marked = markShown(db, [...new Set(findingIds)], now)
  const draftId = currentDraftId(db)
  if (marked.length === 0 || draftId === null) return
  const ids = new Set(marked)
  logShownScenes(
    db,
    findingsOf(db, draftId).filter((finding) => ids.has(finding.id))
  )
}
