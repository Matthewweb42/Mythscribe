import type { UnderlineMode } from '@shared/aiSettings'
import { quickHash } from '@shared/memory/anchor'
import type { CandidateClaim } from '@shared/memory/candidates'
import type { Dismissed } from '@shared/memory/dismissed'
import type { Finding } from '@shared/memory/findings'
import {
  askPanelOnly,
  dropShownTexts,
  EMPTY_UNDERLINE_LOG,
  forgetOutcomes,
  logOutcomes,
  logShownTexts,
  UnderlineLog,
  underlinePrecision,
  type LoggedOutcome,
  type UnderlineOutcome
} from '@shared/memory/underlines'
import type { MemoryHealthReport, MemoryNotice } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import { getNode, type TreeDb } from '../../tree/treeStore'
import { getClaim } from '../reading/claimStore'
import { rowTexts } from '../reading/readingFrame'
import { getNotRightStash, getTopicSnapshots, readRow, writeRow } from '../reading/readerRows'
import { findingRows, type ClosedFinding } from './findingStore'

/**
 * Underline precision (F-16.28; design §2.4 "Underlines", §2.3 "Measuring accuracy", P4-D16): the
 * `memoryUnderlines` settings row logs how each finding that was drawn as an underline closed.
 * `notProblem` counts against (the author dismissed it); `right` counts for (*This one's right*,
 * *Update my note*, or a fix in the text: a reading changed or removed a side's line after the
 * author changed the words of its scene). A finding never underlined, a held side, a draft
 * switch, a deleted record, a scene moved, a flag changed, or a line taken away by a memory
 * correction (*Not right*, *Not a secret*, a spot check, a rebuild) add nothing. Each outcome is
 * kept under its pair's *Not a problem* key with the Dismissed row the answer wrote (P4 slice 5
 * review): the same pair answered again replaces its outcome, and the row's *Undo* takes it back
 * (`forgetAnswer`). When fewer than 70 % of the last 20 were right, Needs a look asks once whether
 * to show contradictions in the panel only (`underlinePrecision`). Read leniently, written whole.
 */

export const MEMORY_UNDERLINES_KEY = 'memoryUnderlines'

/** The id of the one-time question (`MemoryNotice` `underlinePrecision`). */
export const UNDERLINE_NOTICE_ID = 'underlinePrecision'

export function getUnderlineLog(db: TreeDb): UnderlineLog {
  return readRow(db, MEMORY_UNDERLINES_KEY, UnderlineLog, EMPTY_UNDERLINE_LOG)
}

function setUnderlineLog(db: TreeDb, before: UnderlineLog, after: UnderlineLog): void {
  if (after !== before) writeRow(db, MEMORY_UNDERLINES_KEY, after)
}

/** The question was answered (or closed): it is never asked again. */
export function setUnderlineAsked(db: TreeDb): void {
  const log = getUnderlineLog(db)
  if (!log.asked) writeRow(db, MEMORY_UNDERLINES_KEY, { ...log, asked: true })
}

/** A scene's text as a hash, as it reads now (an empty text when the scene is gone). */
function sceneTextHash(db: TreeDb, nodeId: string): string {
  const row = getNode(db, nodeId)
  return quickHash(row === undefined ? '' : rowTexts(row).join('\n'))
}

/** The findings just drawn for the first time: their book sides' scene texts as they read now. */
export function logShownScenes(db: TreeDb, findings: readonly Finding[]): void {
  if (findings.length === 0) return
  const log = getUnderlineLog(db)
  setUnderlineLog(
    db,
    log,
    logShownTexts(
      log,
      findings.map((finding) => ({
        findingId: finding.id,
        texts: Object.fromEntries(
          [finding.a, finding.b].flatMap((side) =>
            side.kind === 'note' ? [] : [[side.nodeId, sceneTextHash(db, side.nodeId)]]
          )
        )
      }))
    )
  )
}

/**
 * Logs the outcomes of the closed findings that were underlined, and forgets every closed
 * finding's scene texts; answers how many outcomes were logged.
 */
function logShown(
  db: TreeDb,
  closed: readonly { finding: Finding; outcome: UnderlineOutcome | null }[],
  dismissedId: string | null
): number {
  if (closed.length === 0) return 0
  const entries = closed.flatMap((each): LoggedOutcome[] =>
    each.finding.shownAt === null || each.outcome === null
      ? []
      : [{ key: each.finding.npKey, outcome: each.outcome, dismissedId }]
  )
  const log = getUnderlineLog(db)
  setUnderlineLog(
    db,
    log,
    dropShownTexts(logOutcomes(log, entries), new Set(closed.map((each) => each.finding.id)))
  )
  return entries.length
}

/**
 * The author's answer closed these findings: *Not a problem* (`notProblem`), or *This one's
 * right* and *Update my note* (`right`), with the Dismissed row the answer wrote (null for *Update
 * my note*). Only those drawn as underlines are logged.
 */
export function logAnswered(
  db: TreeDb,
  closed: readonly ClosedFinding[],
  outcome: UnderlineOutcome,
  dismissedId: string | null
): number {
  return logShown(
    db,
    closed.map((each) => ({ finding: each.finding, outcome })),
    dismissedId
  )
}

/**
 * *Undo* on a Dismissed row took the answer back (P4 slice 5 review): the outcomes it logged go
 * (a *Not a problem* row's pair, a *This one's right* row's), so a finding answered and undone is
 * not counted, and counts once more only when it is answered again. Answers whether any went.
 */
export function forgetAnswer(db: TreeDb, undone: Pick<Dismissed, 'id' | 'kind' | 'key'>): boolean {
  const log = getUnderlineLog(db)
  const next = forgetOutcomes(log, undone)
  setUnderlineLog(db, log, next)
  return next !== log
}

/**
 * Whether a finding the recompute closed because its rule no longer produces it closed because
 * the text changed (P4-D16, "a fix in the text"): a claim side a reading removed (not *Not right*
 * or *Not a secret*, whose lines are kept aside to undo) or read again with another value, in a
 * scene whose text changed since the finding was first drawn (`changed`; so a spot check, a
 * deleted secret or a rebuild that took a line away without the author's words changing is no
 * fix); or, a note conflict whose book side stands as it was, the note changed. A line in a scene
 * now left out of the book, a moved scene, a flashback or a typed detail, or a presence on the
 * page: not counted.
 */
export function fixedInText(
  db: TreeDb,
  finding: Finding,
  live: ReadonlyMap<string, Pick<CandidateClaim, 'valueKey'>>,
  stashed: ReadonlySet<string>,
  changed: (nodeId: string) => boolean
): boolean {
  let bookStands = true
  for (const side of [finding.a, finding.b]) {
    if (side.kind !== 'claim') continue
    const now = live.get(side.claimId)
    const row = now ?? getClaim(db, side.claimId)
    if (row !== null && row.valueKey === side.valueKey) {
      // Still there as it was (live, or kept out of the book's readable scenes).
      if (now === undefined) bookStands = false
      continue
    }
    bookStands = false
    // Gone or read again with another value: a fix only where the author's words changed.
    if ((row !== null || !stashed.has(side.claimId)) && changed(side.nodeId)) return true
  }
  return bookStands && [finding.a, finding.b].some((side) => side.kind === 'note')
}

/** The claim ids kept aside to undo: *Not right › Wrong value*'s and *Not a secret*'s. */
function stashedClaims(db: TreeDb): Set<string> {
  return new Set([
    ...Object.values(getNotRightStash(db)).flatMap((rows) => rows.map((row) => row.id)),
    ...getTopicSnapshots(db).flatMap((snapshot) => snapshot.claims.map((row) => row.id))
  ])
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
  if (closed.length === 0) return 0
  const shown = closed.filter((each) => each.reason === 'gone' && each.finding.shownAt !== null)
  const log = getUnderlineLog(db)
  const texts = new Map(log.shown.map((each) => [each.findingId, each.texts]))
  const stashed = shown.length === 0 ? new Set<string>() : stashedClaims(db)
  return logShown(
    db,
    closed.map((each) => {
      const before = texts.get(each.finding.id)
      const changed = (nodeId: string): boolean =>
        before?.[nodeId] !== undefined && before[nodeId] !== sceneTextHash(db, nodeId)
      return {
        finding: each.finding,
        outcome:
          each.reason === 'gone' &&
          each.finding.shownAt !== null &&
          fixedInText(db, each.finding, live, stashed, changed)
            ? 'right'
            : null
      }
    }),
    null
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
