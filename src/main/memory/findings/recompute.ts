import {
  backgroundCandidates,
  type Candidate,
  type CandidateInputs
} from '@shared/memory/candidates'
import type { FindingCloseReason } from '@shared/memory/findings'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { candidateInputs, findingsFrame } from './candidateInputs'
import {
  closeFindings,
  findingRows,
  toFinding,
  upsertFindings,
  type ClosedFinding,
  type PairVerdicts
} from './findingStore'

/**
 * The local recompute (F-16.27; plan P4 §1.4, design §2.4 "Lifecycle"): after claim changes, scene
 * moves, flag changes, typed-detail changes and note saves, the background candidates (C1–C6) are
 * found again and written by key; a row its rule no longer produces closes itself with a reason
 * (`gone`, or `dismissed` when its *Not a problem* key is on the Dismissed list). A held row never
 * closes while its claims are still there (it waits for the re-read, P4-D13); a C7 row (made only by
 * *Check the book*) closes only when a side is gone. No AI, no text read beyond the cards a rule
 * asks about: under 50 ms on a 90-scene book (`findings.perf.test.ts`).
 */

export interface RecomputeResult {
  /** Findings open now that were not before. */
  opened: string[]
  /** Findings closed, each with its reason. */
  closed: ClosedFinding[]
  /** Findings waiting for a verdict. */
  unjudged: number
  /** Anything written or closed. */
  changed: boolean
}

export interface RecomputeOptions {
  /** Both orders' verdicts the cache holds for a candidate (slice 2 renders the pair to key it). */
  cached?: (candidate: Candidate) => PairVerdicts | null
  /** The rules' inputs, when the caller built them. */
  inputs?: CandidateInputs
}

const NOTHING: RecomputeResult = { opened: [], closed: [], unjudged: 0, changed: false }

/** Finds the background candidates again over the active draft and brings its findings in line. */
export function recomputeFindings(
  db: TreeDb,
  now: Date,
  options: RecomputeOptions = {}
): RecomputeResult {
  const draftId = currentDraftId(db)
  if (draftId === null) return NOTHING
  const inputs = options.inputs ?? candidateInputs(db, draftId, findingsFrame(db))
  const candidates = backgroundCandidates(inputs)
  const upsert = upsertFindings(db, draftId, candidates, now, options.cached)
  const produced = new Set(candidates.map((each) => each.key))
  const claims = new Set(inputs.claims.map((each) => each.id))
  const closing: { key: string; reason: FindingCloseReason }[] = []
  const rows = findingRows(db, draftId)
  for (const row of rows) {
    if (produced.has(row.key)) continue
    if (inputs.dismissed.has(row.npKey)) {
      closing.push({ key: row.key, reason: 'dismissed' })
      continue
    }
    const parsed = toFinding(row)
    const sideGone =
      parsed === null ||
      [parsed.a, parsed.b].some((side) => side.kind === 'claim' && !claims.has(side.claimId))
    // Held rows wait for their re-read; C7 rows are Check the book's, out of the background set.
    if ((row.state === 'held' || row.rule === 'C7') && !sideGone) continue
    closing.push({ key: row.key, reason: 'gone' })
  }
  const closed = closeFindings(db, draftId, closing)
  const gone = new Set(closing.map((each) => each.key))
  const unjudged = rows.filter((row) => row.state === 'unjudged' && !gone.has(row.key)).length
  return {
    opened: upsert.opened,
    closed,
    unjudged,
    changed: upsert.written > 0 || closed.length > 0
  }
}
