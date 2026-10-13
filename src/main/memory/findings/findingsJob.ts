import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { findingRows } from './findingStore'
import { recomputeFindings, type RecomputeOptions, type RecomputeResult } from './recompute'

/**
 * The local `findings` job (F-16.27; plan P4 §1.4): one per project, keyed to the manuscript root on
 * the mention queue beside the anchors job, debounced and coalesced, queued by every change to what
 * the memory holds (`memoryChanged` in the handlers), scene moves, flag and draft changes, typed
 * details and note saves. It runs the recompute and answers the counts `memory:findingsChanged`
 * carries; from slice 2 it also asks the findings service to judge. Story memory v2 only.
 */

/** What `memory:findingsChanged` carries: open, unclear and waiting (unjudged) findings. */
export interface FindingCounts {
  open: number
  unclear: number
  waiting: number
}

/** The active draft's finding counts. */
export function findingCounts(db: TreeDb): FindingCounts {
  const draftId = currentDraftId(db)
  if (draftId === null) return { open: 0, unclear: 0, waiting: 0 }
  const rows = findingRows(db, draftId, ['open', 'unclear', 'unjudged'])
  return {
    open: rows.filter((row) => row.state === 'open').length,
    unclear: rows.filter((row) => row.state === 'unclear').length,
    waiting: rows.filter((row) => row.state === 'unjudged').length
  }
}

/** One run of the job: the recompute, and the counts when anything moved. */
export function runFindingsJob(
  db: TreeDb,
  now: Date,
  options: RecomputeOptions = {}
): RecomputeResult & { counts: FindingCounts | null } {
  const result = recomputeFindings(db, now, options)
  return { ...result, counts: result.changed ? findingCounts(db) : null }
}
