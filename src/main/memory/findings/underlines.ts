import type { UnderlineMode } from '@shared/aiSettings'
import { pickUnderlines, type UnderlineView } from '@shared/memory/underlines'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { findingsOf, markShown } from './findingStore'
import { findingView } from './findingViews'
import { judgeContext } from './judge'

/**
 * A scene's contradiction underlines (F-16.28; design §2.4 "Underlines", plan P4 §5.1, P4-D15): the
 * active draft's open findings with a book quote (a line or a character on the page) in the scene,
 * resolved against the text as it is now, picked by `pickUnderlines` (rule order, then the newest;
 * at most 3 marks; never in a paragraph with a finished sentence not read yet). The editor draws
 * them as decorations only. None while the Contradiction check is off (P4-D21) or contradictions
 * show in the panel only. Local and free; the judge's context is built only when the scene has an
 * open finding.
 */
export function sceneUnderlines(
  db: TreeDb,
  nodeId: string,
  unreadParas: ReadonlySet<number>,
  options: { on: boolean; mode: UnderlineMode }
): UnderlineView[] {
  if (!options.on || options.mode === 'panel') return []
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const here = findingsOf(db, draftId, ['open']).filter((finding) =>
    [finding.a, finding.b].some((side) => side.kind !== 'note' && side.nodeId === nodeId)
  )
  if (here.length === 0) return []
  const ctx = judgeContext(db, draftId)
  const views = here.flatMap((finding) => {
    const view = findingView(ctx, finding)
    return view === null ? [] : [{ finding: view, created: finding.created }]
  })
  return pickUnderlines(views, nodeId, { unreadParas }).map((mark) => ({
    findingId: mark.findingId,
    side: mark.side,
    para: mark.para,
    quote: mark.quote,
    finding: mark.finding
  }))
}

/** The editor drew these findings (`memory:underlinesShown`): each one's `shown_at`, once. */
export function underlinesShown(db: TreeDb, findingIds: readonly string[], now: Date): void {
  markShown(db, [...new Set(findingIds)], now)
}
