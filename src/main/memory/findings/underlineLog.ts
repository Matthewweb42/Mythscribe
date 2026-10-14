import type { UnderlineMode } from '@shared/aiSettings'
import type { CandidateClaim } from '@shared/memory/candidates'
import type { Finding } from '@shared/memory/findings'
import {
  askPanelOnly,
  EMPTY_UNDERLINE_LOG,
  logOutcomes,
  UnderlineLog,
  underlinePrecision,
  type UnderlineOutcome
} from '@shared/memory/underlines'
import type { MemoryHealthReport, MemoryNotice } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { getClaim } from '../reading/claimStore'
import { getNotRightStash, readRow, writeRow } from '../reading/readerRows'
import { findingRows, type ClosedFinding } from './findingStore'

/**
 * Underline precision (F-16.28; design §2.4 "Underlines", §2.3 "Measuring accuracy", P4-D16): the
 * `memoryUnderlines` settings row logs how each finding that was drawn as an underline closed.
 * `notProblem` counts against (the author dismissed it); `right` counts for (*This one's right*,
 * *Update my note*, or a fix in the text: a reading changed or removed a side's line). A finding
 * never underlined, a held side, a draft switch, a deleted record, a scene moved or a flag changed
 * add nothing. When fewer than 70 % of the last 20 were right, Needs a look asks once whether to
 * show contradictions in the panel only (`underlinePrecision`). Read leniently, written whole.
 */

export const MEMORY_UNDERLINES_KEY = 'memoryUnderlines'

/** The id of the one-time question (`MemoryNotice` `underlinePrecision`). */
export const UNDERLINE_NOTICE_ID = 'underlinePrecision'

export function getUnderlineLog(db: TreeDb): UnderlineLog {
  return readRow(db, MEMORY_UNDERLINES_KEY, UnderlineLog, EMPTY_UNDERLINE_LOG)
}

/** The question was answered (or closed): it is never asked again. */
export function setUnderlineAsked(db: TreeDb): void {
  const log = getUnderlineLog(db)
  if (!log.asked) writeRow(db, MEMORY_UNDERLINES_KEY, { ...log, asked: true })
}

/** Logs the outcomes of the closed findings that were underlined; answers how many were logged. */
function logShown(
  db: TreeDb,
  closed: readonly { finding: Finding; outcome: UnderlineOutcome | null }[]
): number {
  const outcomes = closed.flatMap((each) =>
    each.finding.shownAt === null || each.outcome === null ? [] : [each.outcome]
  )
  if (outcomes.length > 0) {
    writeRow(db, MEMORY_UNDERLINES_KEY, logOutcomes(getUnderlineLog(db), outcomes))
  }
  return outcomes.length
}

/**
 * The author's answer closed these findings: *Not a problem* (`notProblem`), or *This one's
 * right* and *Update my note* (`right`). Only those drawn as underlines are logged.
 */
export function logAnswered(
  db: TreeDb,
  closed: readonly ClosedFinding[],
  outcome: UnderlineOutcome
): number {
  return logShown(
    db,
    closed.map((each) => ({ finding: each.finding, outcome }))
  )
}

/**
 * Whether a finding the recompute closed because its rule no longer produces it closed because
 * the text changed (P4-D16, "a fix in the text"): a claim side a reading removed (not *Not right*,
 * whose lines are kept aside to undo) or read again with another value; or, a note conflict whose
 * book side stands as it was, the note changed. A line in a scene now left out of the book, a
 * moved scene, a flashback or a typed detail, or a presence on the page: not counted.
 */
export function fixedInText(
  db: TreeDb,
  finding: Finding,
  live: ReadonlyMap<string, Pick<CandidateClaim, 'valueKey'>>,
  stashed: ReadonlySet<string>
): boolean {
  let bookStands = true
  for (const side of [finding.a, finding.b]) {
    if (side.kind !== 'claim') continue
    const now = live.get(side.claimId)
    if (now !== undefined) {
      if (now.valueKey !== side.valueKey) return true
      continue
    }
    const row = getClaim(db, side.claimId)
    if (row === null) {
      if (!stashed.has(side.claimId)) return true
      bookStands = false
      continue
    }
    if (row.valueKey !== side.valueKey) return true
    bookStands = false
  }
  return bookStands && [finding.a, finding.b].some((side) => side.kind === 'note')
}

/** The claim ids *Not right › Wrong value* has kept aside (`memoryNotRight`). */
function stashedClaims(db: TreeDb): Set<string> {
  return new Set(
    Object.values(getNotRightStash(db)).flatMap((rows) => rows.map((row) => row.id))
  )
}

/**
 * The recompute closed these findings (`gone`): those drawn as underlines that closed for a fix
 * in the text are logged `right`; the rest add nothing. `live` is the recompute's claims (live or
 * stale, in readable scenes) by id.
 */
export function logGone(
  db: TreeDb,
  closed: readonly ClosedFinding[],
  live: ReadonlyMap<string, Pick<CandidateClaim, 'valueKey'>>
): number {
  const shown = closed.filter((each) => each.reason === 'gone' && each.finding.shownAt !== null)
  if (shown.length === 0) return 0
  const stashed = stashedClaims(db)
  return logShown(
    db,
    shown.map((each) => ({
      finding: each.finding,
      outcome: fixedInText(db, each.finding, live, stashed) ? 'right' : null
    }))
  )
}

/**
 * The one-time question (design §2.4), while contradictions are underlined and the Contradiction
 * check is on: "Of the last 20 underlined contradictions, 8 were not problems. Show contradictions
 * in the panel only?"; null when it is not due.
 */
export function underlineNotice(
  db: TreeDb,
  settings: { features: { judge: boolean }; reading: { underlines: UnderlineMode } }
): MemoryNotice | null {
  if (!settings.features.judge || settings.reading.underlines !== 'text') return null
  const log = getUnderlineLog(db)
  if (!askPanelOnly(log)) return null
  const precision = underlinePrecision(log.outcomes)
  return {
    id: UNDERLINE_NOTICE_ID,
    kind: 'underlinePrecision',
    counted: precision.counted,
    notProblems: precision.counted - precision.right
  }
}

/**
 * Settings › AI › Story memory's details (design §2.3 "Measuring accuracy"): the active draft's
 * pairs the judge ruled on in both orders and how many the two orders agreed on, and the last 20
 * underlined contradictions that closed with how many were right. Never "accuracy".
 */
export function contradictionStats(db: TreeDb): MemoryHealthReport['contradictions'] {
  const draftId = currentDraftId(db)
  const judged = (draftId === null ? [] : findingRows(db, draftId)).filter(
    (row) => row.verdictAb !== null && row.verdictBa !== null
  )
  const precision = underlinePrecision(getUnderlineLog(db).outcomes)
  return {
    pairs: judged.length,
    agreed: judged.filter((row) => row.verdictAb === row.verdictBa).length,
    underlines: { counted: precision.counted, right: precision.right }
  }
}
