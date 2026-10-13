import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { candidateInputs, findingsFrame } from './candidateInputs'
import { findingRows, type PairReader } from './findingStore'
import { judgeContext, pairReader } from './judge'
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

const NO_COUNTS: FindingCounts = { open: 0, unclear: 0, waiting: 0 }

/**
 * The active draft's finding counts; none while findings are hidden (`shown` false: the
 * Contradiction check is off, as `memory:findings` answers then, P4-D21).
 */
export function findingCounts(db: TreeDb, shown = true): FindingCounts {
  const draftId = currentDraftId(db)
  if (!shown || draftId === null) return { ...NO_COUNTS }
  const rows = findingRows(db, draftId, ['open', 'unclear', 'unjudged'])
  return {
    open: rows.filter((row) => row.state === 'open').length,
    unclear: rows.filter((row) => row.state === 'unclear').length,
    waiting: rows.filter((row) => row.state === 'unjudged').length
  }
}

/**
 * One run of the job: the recompute, and the counts when anything a view shows moved.
 * `cachedVerdicts` (slice 2): pairs are read as the judge reads them (`judge.ts`), rendered again
 * only when the stamp of what they read moved, so a pair whose words changed is judged afresh and a
 * new or re-rendered one takes both orders' remembered verdicts from `verdict_cache` at no cost.
 * `shown` (the Contradiction check switch): off, the counts are none.
 */
export function runFindingsJob(
  db: TreeDb,
  now: Date,
  options: RecomputeOptions & { cachedVerdicts?: boolean; shown?: boolean } = {}
): RecomputeResult & { counts: FindingCounts | null } {
  const { cachedVerdicts, shown = true, ...recompute } = options
  const draftId = currentDraftId(db)
  if (cachedVerdicts === true && draftId !== null && recompute.pairs === undefined) {
    const frame = findingsFrame(db)
    const inputs = recompute.inputs ?? candidateInputs(db, draftId, frame)
    let reader: PairReader | null = null
    const lazily = (): PairReader => {
      reader ??= pairReader(judgeContext(db, draftId, frame, inputs), now)
      return reader
    }
    recompute.inputs = inputs
    recompute.pairs = {
      read: (candidate, stored) => lazily().read(candidate, stored),
      cached: (keys) => lazily().cached(keys)
    }
  }
  const result = recomputeFindings(db, now, recompute)
  return { ...result, counts: result.changed ? findingCounts(db, shown) : null }
}
