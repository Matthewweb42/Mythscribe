import { renderSceneMood } from '@shared/sceneCard'
import { getSummary } from '../../document/summaryStore'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The scene mood block a prose-edit prompt carries (F-5.6, the author 2026-10-10): the mood and
 * theme the scene's last reading deduced (`summary.v5`, stored on the summary's card), rendered by
 * the pure `renderSceneMood`. Null for a scene with no reading yet, or one read before `summary.v5`
 * (it gets them with its next reading). One read of a stored row, no request; the rendered string
 * goes into the feature's context hash, so a scene re-read with another mood misses the cache.
 */
export function buildSceneMood(db: TreeDb, nodeId: string): string | null {
  const card = getSummary(db, nodeId)?.card ?? null
  return card === null ? null : renderSceneMood(card.mood, card.theme)
}
