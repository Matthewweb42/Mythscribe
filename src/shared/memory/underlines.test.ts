import { describe, expect, it } from 'vitest'
import type { FindingRule } from './findings'
import {
  askPanelOnly,
  EMPTY_UNDERLINE_LOG,
  logOutcomes,
  pickUnderlines,
  PRECISION_WINDOW,
  UNDERLINE_LOG_MAX,
  UnderlineLog,
  underlinePrecision,
  type PickFinding,
  type UnderlineOutcome
} from './underlines'

type Side = PickFinding['a']

const claim = (nodeId: string, para: number, quote: string): Side => ({
  kind: 'claim',
  nodeId,
  para,
  quote
})

const note: Side = { kind: 'note', nodeId: null, para: 0, quote: 'Eyes: green' }

function finding(
  id: string,
  rule: FindingRule,
  a: Side,
  b: Side,
  created: string,
  state = 'open'
): { finding: PickFinding; created: string } {
  return { finding: { id, rule, state, a, b }, created }
}

const ids = (marks: { findingId: string; side: string }[]): string[] =>
  marks.map((each) => `${each.findingId}:${each.side}`)

describe('pickUnderlines (F-16.28, P4-D15)', () => {
  const none = new Set<number>()

  it('marks the open findings’ quotes in the scene, both quotes of a same-scene pair', () => {
    const marks = pickUnderlines(
      [
        finding('f1', 'C1', claim('s1', 0, 'grey'), claim('s2', 0, 'brown'), '2026-10-01'),
        finding('f2', 'C2', claim('s2', 1, 'died'), claim('s2', 3, 'Hobb said'), '2026-10-01')
      ],
      's2',
      { unreadParas: none }
    )
    expect(ids(marks)).toEqual(['f1:b', 'f2:a', 'f2:b'])
    expect(marks[0]).toMatchObject({ para: 0, quote: 'brown' })
  })

  it('never marks a finding that is not open, a note side, or a side in another scene', () => {
    const marks = pickUnderlines(
      [
        finding('unclear', 'C1', claim('s1', 0, 'x'), claim('s2', 0, 'y'), '1', 'unclear'),
        finding('held', 'C1', claim('s1', 0, 'x'), claim('s1', 1, 'y'), '1', 'held'),
        finding('note', 'C6', note, claim('s1', 2, 'green eyes'), '1'),
        finding('far', 'C1', claim('s3', 0, 'a'), claim('s4', 0, 'b'), '1')
      ],
      's1',
      { unreadParas: none }
    )
    expect(ids(marks)).toEqual(['note:b'])
  })

  it('takes rules in order, then the newest, at most three marks, a finding whole or not at all', () => {
    const marks = pickUnderlines(
      [
        finding('old-c1', 'C1', claim('s1', 0, 'q0'), claim('s0', 0, 'x'), '2026-10-01'),
        finding('c5', 'C5', claim('s1', 1, 'q1'), claim('s1', 2, 'q2'), '2026-10-09'),
        finding('new-c1', 'C1', claim('s1', 3, 'q3'), claim('s0', 1, 'y'), '2026-10-05'),
        finding('c2', 'C2', claim('s1', 4, 'q4'), claim('s1', 5, 'q5'), '2026-10-08'),
        finding('c6', 'C6', note, claim('s1', 6, 'q6'), '2026-10-02')
      ],
      's1',
      { unreadParas: none }
    )
    // C1 newest first, then C6 (rule order C1, C6, C2, …); the C2 pair no longer fits.
    expect(ids(marks)).toEqual(['new-c1:a', 'old-c1:a', 'c6:b'])
    expect(marks).toHaveLength(3)
  })

  it('fills past a pair that does not fit with a later single mark', () => {
    const marks = pickUnderlines(
      [
        finding('one', 'C1', claim('s1', 0, 'q0'), claim('s0', 0, 'x'), '2'),
        finding('two', 'C1', claim('s1', 1, 'q1'), claim('s0', 1, 'y'), '1'),
        finding('pair', 'C2', claim('s1', 2, 'q2'), claim('s1', 3, 'q3'), '3'),
        finding('three', 'C5', claim('s1', 4, 'q4'), claim('s0', 2, 'z'), '1')
      ],
      's1',
      { unreadParas: none }
    )
    expect(ids(marks)).toEqual(['one:a', 'two:a', 'three:a'])
  })

  it('leaves out a side in a paragraph with an unread change, keeping the other', () => {
    const marks = pickUnderlines(
      [finding('f', 'C2', claim('s1', 0, 'died'), claim('s1', 2, 'here'), '1')],
      's1',
      { unreadParas: new Set([2]) }
    )
    expect(ids(marks)).toEqual(['f:a'])
    expect(
      pickUnderlines(
        [finding('f', 'C1', claim('s1', 2, 'grey'), claim('s0', 0, 'brown'), '1')],
        's1',
        { unreadParas: new Set([2]) }
      )
    ).toEqual([])
  })

  it('marks one quote once, whichever findings share it', () => {
    const marks = pickUnderlines(
      [
        finding('brown', 'C1', claim('s1', 0, 'grey'), claim('s2', 0, 'brown'), '2'),
        finding('green', 'C1', claim('s1', 0, 'grey'), claim('s3', 0, 'green'), '1')
      ],
      's1',
      { unreadParas: none }
    )
    expect(ids(marks)).toEqual(['brown:a'])
  })
})

describe('underline precision (P4-D16)', () => {
  const run = (right: number, notProblem: number): UnderlineOutcome[] => [
    ...Array.from({ length: right }, (): UnderlineOutcome => 'right'),
    ...Array.from({ length: notProblem }, (): UnderlineOutcome => 'notProblem')
  ]

  it('counts the last 20 outcomes', () => {
    expect(underlinePrecision([])).toEqual({ counted: 0, right: 0, share: null })
    // 10 not problems long ago, then 14 right and 6 not problems: only the last 20 count.
    const outcomes = [...run(0, 10), ...run(14, 6)]
    expect(underlinePrecision(outcomes)).toEqual({ counted: 20, right: 14, share: 0.7 })
  })

  it('asks once, only over a full window under 70 % right', () => {
    const low = logOutcomes(EMPTY_UNDERLINE_LOG, run(13, 7))
    expect(askPanelOnly(low)).toBe(true)
    expect(askPanelOnly({ ...low, asked: true })).toBe(false)
    expect(askPanelOnly(logOutcomes(EMPTY_UNDERLINE_LOG, run(14, 6)))).toBe(false)
    expect(askPanelOnly(logOutcomes(EMPTY_UNDERLINE_LOG, run(0, PRECISION_WINDOW - 1)))).toBe(false)
  })

  it('keeps the newest 50 outcomes and reads a broken row leniently', () => {
    const log = logOutcomes(EMPTY_UNDERLINE_LOG, [...run(0, 10), ...run(60, 0)])
    expect(log.outcomes).toHaveLength(UNDERLINE_LOG_MAX)
    expect(log.outcomes.every((each) => each === 'right')).toBe(true)
    expect(logOutcomes(log, [])).toBe(log)
    expect(UnderlineLog.parse({ outcomes: ['right', 'maybe'], asked: 'yes' })).toEqual({
      outcomes: [],
      asked: false
    })
    expect(UnderlineLog.parse({})).toEqual(EMPTY_UNDERLINE_LOG)
  })
})
