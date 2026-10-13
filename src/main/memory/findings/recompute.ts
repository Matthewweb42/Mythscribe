import {
  backgroundCandidates,
  claimSide,
  type Candidate,
  type CandidateClaim,
  type CandidateInputs
} from '@shared/memory/candidates'
import type { Finding, FindingCloseReason, FindingSide } from '@shared/memory/findings'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { candidateInputs, findingsFrame } from './candidateInputs'
import {
  closeFindings,
  countFindings,
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
 * (`gone`, or `dismissed` when its *Not a problem* key is on the Dismissed list). A row no longer
 * produced waits, held, only while one of its claim sides is still stale (P4-D13: it never closes
 * for being stale, and its re-read decides); once no side is stale it closes like any other. A C7
 * row (made only by *Check the book*) closes only when a side is gone, and is held while a side is
 * stale. No AI, no text read beyond the cards a rule asks about: under 50 ms on a 90-scene book
 * (`findings.perf.test.ts`).
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

/**
 * A stored finding the background set did not produce, restated as its candidate: its claim sides
 * as the claims stand now (so a revival's new words are seen), held while one of them is stale.
 */
function restated(each: Finding, claims: ReadonlyMap<string, CandidateClaim>): Candidate {
  const side = (at: FindingSide): FindingSide => {
    if (at.kind !== 'claim') return at
    const now = claims.get(at.claimId)
    return now === undefined ? at : claimSide(now)
  }
  return {
    rule: each.rule,
    variant: each.variant,
    recordId: each.recordId,
    slot: each.slot,
    a: side(each.a),
    b: side(each.b),
    extra: each.extra,
    held: [each.a, each.b].some(
      (at) => at.kind === 'claim' && claims.get(at.claimId)?.state === 'stale'
    ),
    hidden: each.state === 'hidden',
    npKey: each.npKey,
    key: each.key
  }
}

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
  const produced = new Set(candidates.map((each) => each.key))
  const claims = new Map(inputs.claims.map((each) => [each.id, each]))
  const closing: { key: string; reason: FindingCloseReason }[] = []
  const kept: Candidate[] = []
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
    if (parsed === null || sideGone) {
      closing.push({ key: row.key, reason: 'gone' })
      continue
    }
    const again = restated(parsed, claims)
    // C7 rows are Check the book's, out of the background set; others wait only for a re-read.
    if (row.rule === 'C7' || again.held) kept.push(again)
    else closing.push({ key: row.key, reason: 'gone' })
  }
  const upsert = upsertFindings(db, draftId, [...candidates, ...kept], now, options.cached, rows)
  const closed = closeFindings(db, draftId, closing)
  return {
    opened: upsert.opened,
    closed,
    unjudged: countFindings(db, draftId, 'unjudged'),
    changed: upsert.written > 0 || closed.length > 0
  }
}
