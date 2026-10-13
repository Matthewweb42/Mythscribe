import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeForMatch } from '@shared/critique'
import { backgroundCandidates, candidatesC7, type Candidate } from '@shared/memory/candidates'
import type { FindingSide } from '@shared/memory/findings'
import { looseEnds } from '@shared/memory/looseEnds'
import { normName } from '@shared/memory/names'
import { activeDraftId } from '../../draft/draftStore'
import { dismissedKeys } from '../../memory/dismissedStore'
import {
  candidateInputs,
  findingsFrame,
  looseEndInputs
} from '../../memory/findings/candidateInputs'
import { findingRows, invariantFindings } from '../../memory/findings/findingStore'
import { recomputeFindings } from '../../memory/findings/recompute'
import { draftClaims } from '../../memory/reading/claimStore'
import { fakeAi, requestKind } from '../../memory/reading/readingFixture'
import { listTopics } from '../../memory/reading/topicStore'
import { TEST_BOOK } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { TestBookLabels } from '../../memory/testBook/labels.schema'
import {
  addTestBookNotes,
  buildTestBookProject,
  type TestBookProject
} from '../../memory/testBook/project'
import { invariants, oracleRead, oracleVerify, overlaps, readBook, sceneOf } from './memoryOracle'

/**
 * The contradiction candidates and loose ends over the test book (F-16.27, F-16.29; plan P4 §1.6,
 * §1.7), `npm run eval:ai` (and so `npm run test`). No AI judges anything here (slice 1 is code
 * only): the book is read by P2a/P2b's oracle (`memoryOracle.ts`: the reader proposes exactly the
 * labels, the honest checker answers by them), the P4 records' Pinned notes and the Research page
 * are written and indexed, and then the rules run as the app's `findings` job runs them:
 *
 * - every labelled contradiction is a background candidate (C1–C6) with the labelled sides, a C7
 *   one only a *Check the book* candidate, and the h16 one (Hobb at the gate in a flashback) made
 *   and hidden;
 * - no `finding` negative is a candidate, except the judge traps the labels mark `candidate`
 *   (the lie in speech, the remembered colour against a note), which must be;
 * - the recompute stores the background candidates once, unjudged (or hidden), and a second run
 *   changes nothing; the invariants hold with the findings in;
 * - the loose ends as of the end of the book are the labels' own.
 */

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

type LabelContradiction = TestBookLabels['contradictions'][number]
type LabelNegative = TestBookLabels['negatives'][number]

let tmp: string
let book: TestBookProject
let outcomes: Map<string, string>
let background: Candidate[]
let check: Candidate[]

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-eval-'))
  book = buildTestBookProject(tmp, NOW)
  addTestBookNotes(book, NOW)
  const ai = fakeAi(
    (request) => ({
      text: requestKind(request) === 'verify' ? oracleVerify(request) : oracleRead(request)
    }),
    { now: NOW }
  )
  outcomes = await readBook(book, ai.deps)
  const inputs = candidateInputs(book.db, activeDraftId(book.db))
  background = backgroundCandidates(inputs)
  check = candidatesC7(inputs)
}, 60_000)

afterAll(() => {
  book.session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A labelled record's id in the project: a record the book was built with, or a topic it made. */
function recordOf(label: string): string | null {
  const made = book.records.get(label)
  if (made !== undefined) return made
  const name = TEST_BOOK_LABELS.records.find((record) => record.id === label)?.name ?? ''
  return (
    listTopics(book.db).find((topic) => normName(topic.label) === normName(name))?.recordId ?? null
  )
}

/** Whether a side is the labelled passage: a claim with that quote there, or a presence there. */
function sideIs(side: FindingSide, ref: { scene: string; quote: string }): boolean {
  if (side.kind === 'presence') return sceneOf(book, side.nodeId) === ref.scene
  if (side.kind !== 'claim') return false
  const claim = draftClaims(book.db, activeDraftId(book.db)).find(
    (each) => each.id === side.claimId
  )
  return (
    claim !== undefined &&
    sceneOf(book, claim.nodeId) === ref.scene &&
    overlaps(claim.quote, ref.quote)
  )
}

/** Whether a side is the labelled note line (a Pinned page's or the Research page's). */
function noteIs(side: FindingSide, note: NonNullable<LabelContradiction['note']>): boolean {
  if (side.kind !== 'note') return false
  if (note.record !== undefined && side.ownerId !== recordOf(note.record)) return false
  if (note.research !== undefined && side.ownerKind !== 'research') return false
  return normalizeForMatch(note.quote).includes(normalizeForMatch(side.value))
}

/** The candidates a labelled contradiction is, either way round. */
function matches(label: LabelContradiction, among: readonly Candidate[]): Candidate[] {
  const recordId = recordOf(label.record)
  return among.filter((candidate) => {
    if (candidate.rule !== label.rule || candidate.recordId !== recordId) return false
    if (label.variant !== undefined && candidate.variant !== label.variant) return false
    const sides = [candidate.a, candidate.b]
    const other = (side: FindingSide): boolean =>
      label.b !== undefined
        ? sideIs(side, label.b)
        : label.note !== undefined && noteIs(side, label.note)
    return sides.some((side, i) => sideIs(side, label.a) && other(sides[1 - i] ?? side))
  })
}

/** The candidates a `finding` negative forbids (or, for a judge trap, asks for). */
function negativeHits(negative: LabelNegative, among: readonly Candidate[]): Candidate[] {
  const recordId = negative.record === undefined ? null : recordOf(negative.record)
  return among.filter(
    (candidate) =>
      candidate.rule === negative.rule &&
      (recordId === null || candidate.recordId === recordId) &&
      (negative.slot === undefined ||
        candidate.slot === negative.slot ||
        candidate.slot.startsWith(`${negative.slot}:`)) &&
      [candidate.a, candidate.b].some(
        (side) => side.kind !== 'note' && sceneOf(book, side.nodeId) === negative.scene
      )
  )
}

const label = (each: LabelContradiction): string =>
  `${each.rule}${each.variant === undefined ? '' : ` ${each.variant}`} ${each.record}: ${each.a.quote}`

describe('the contradiction candidates over the test book (F-16.27)', () => {
  it('reads every manuscript scene of the book', () => {
    for (const scene of TEST_BOOK) {
      if (scene.source === 'scene') expect(outcomes.get(scene.id), scene.id).toBe('read')
    }
  })

  it('makes every labelled contradiction a candidate: C1–C6 in the background, C7 on a check', () => {
    const missed = TEST_BOOK_LABELS.contradictions.flatMap((each) => {
      const among = each.rule === 'C7' ? check : background
      return matches(each, among).length === 1 ? [] : [label(each)]
    })
    expect(missed).toEqual([])
    // C7 is never a background candidate (plan P4-D4).
    expect(background.filter((each) => each.rule === 'C7')).toEqual([])
  })

  it('hides the flashback one, and only it', () => {
    for (const each of TEST_BOOK_LABELS.contradictions) {
      const [found] = matches(each, each.rule === 'C7' ? check : background)
      expect([found?.hidden, found?.held], label(each)).toEqual([each.hidden ?? false, false])
    }
  })

  it('makes no candidate a negative forbids, and every judge trap’s', () => {
    const all = [...background, ...check]
    const wrong = TEST_BOOK_LABELS.negatives.flatMap((negative) => {
      if (negative.kind !== 'finding' || negative.rule === undefined) return []
      const hits = negativeHits(negative, all).length
      const trap = negative.candidate ?? false
      return (trap ? hits > 0 : hits === 0)
        ? []
        : [`${negative.scene} ${negative.rule} ${negative.record ?? ''}: ${negative.reason}`]
    })
    expect(wrong).toEqual([])
  })

  it('stores the background candidates once, unjudged or hidden, and a second run moves nothing', () => {
    const first = recomputeFindings(book.db, NOW)
    const rows = findingRows(book.db, activeDraftId(book.db))
    expect(rows.map((row) => row.key).sort()).toEqual(background.map((each) => each.key).sort())
    for (const each of TEST_BOOK_LABELS.contradictions) {
      const [found] = matches(each, each.rule === 'C7' ? check : background)
      const row = rows.find((candidate) => candidate.key === found?.key)
      if (each.rule === 'C7') expect(row, label(each)).toBeUndefined()
      else expect(row?.state, label(each)).toBe(each.hidden === true ? 'hidden' : 'unjudged')
    }
    expect(first.opened).toEqual([])
    expect(recomputeFindings(book.db, NOW).changed).toBe(false)
  })

  it('keeps the memory invariants with the findings in', () => {
    const draftId = activeDraftId(book.db)
    const { reading } = findingsFrame(book.db)
    expect(
      invariants(book, [], {
        findings: invariantFindings(book.db, draftId, (nodeId) => reading.order.has(nodeId)),
        dismissedFindings: dismissedKeys(book.db, 'notProblem')
      })
    ).toEqual([])
  })
})

describe('the loose ends of the test book (F-16.29)', () => {
  it('lists what the labels say the book leaves hanging, where each was last touched', () => {
    const view = looseEnds(looseEndInputs(book.db, activeDraftId(book.db)))
    const labelOf = new Map(
      TEST_BOOK_LABELS.records.map((record) => [recordOf(record.id) ?? '', record.id])
    )
    const scene = (nodeId: string | null): string | null =>
      nodeId === null ? null : sceneOf(book, nodeId)
    expect(
      view.items.map((item) => [
        item.kind,
        item.kind === 'planned' ? scene(item.id) : (labelOf.get(item.id) ?? item.id),
        scene(item.lastNodeId)
      ])
    ).toEqual(TEST_BOOK_LABELS.looseEnds.map((each) => [each.kind, each.id, each.last ?? null]))
    expect(view.more).toBe(0)
    // Every question it would send is worded as a question, never as an absence.
    for (const item of view.items) expect(item.ask).toMatch(/\?$/)
  })
})
