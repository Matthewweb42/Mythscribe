import { renderSceneMood } from '@shared/sceneCard'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { getSummary } from '../../document/summaryStore'
import { cardMoodOf } from '../../memory/reading/cardContext'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The scene mood block a prose-edit prompt carries (F-5.6, the author 2026-10-10): the mood and
 * theme the scene's last reading deduced, rendered by the pure `renderSceneMood`. Story memory v1
 * reads them from the summary's card (`summary.v5`); v2 (F-16.20) from the active draft's v2 card
 * (`reader.v1`). Null for a scene with no reading yet (or one read before `summary.v5`, in v1).
 * One read of a stored row, no request; the rendered string goes into the feature's context hash,
 * so a scene re-read with another mood misses the cache.
 */
export function buildSceneMood(
  db: TreeDb,
  nodeId: string,
  memory: StoryMemoryVersion
): string | null {
  const card = memory === 'v2' ? cardMoodOf(db, nodeId) : (getSummary(db, nodeId)?.card ?? null)
  return card === null ? null : renderSceneMood(card.mood, card.theme)
}
