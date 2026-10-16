import { describe, expect, it } from 'vitest'
import { normalizeForMatch } from '@shared/critique'
import { AiFallbackError } from '../ai/providers/types'
import { EDIT_FLOW_TIMELINE_EVENTS_MAX } from '@shared/editFlow'
import { parseFlowIssues, parseFlowNotes, type ParseIssuesInput } from './parse'
import type { FlowSliceItem } from './plan'

const ONE = 'Mara climbed the ridge alone. Her eyes were brown as river mud.\n\nShe teh sea below.'
const TWO = 'Rook waited at the quay with the ledger.\n\nThe tide turned at dusk.'

const items: FlowSliceItem[] = [
  { nodeId: 'sc-1', ref: 'n3', title: 'Chapter 1 › Mara', text: ONE, part: { index: 0, count: 1 } },
  { nodeId: 'sc-2', ref: 'n4', title: 'Chapter 1 › Rook', text: TWO, part: { index: 0, count: 1 } }
]

function input(over: Partial<ParseIssuesInput> = {}): ParseIssuesInput {
  return {
    family: 'copy',
    checks: [],
    items,
    scenes: new Map([
      ['sc-1', normalizeForMatch(ONE)],
      ['sc-2', normalizeForMatch(TWO)]
    ]),
    keep: new Set(),
    taken: new Map(),
    ...over
  }
}

const answer = (value: unknown): string => JSON.stringify(value)

describe('parseFlowIssues (the edit flow’s answers, quotes checked locally)', () => {
  it('keeps a fix as a tracked change in the scene its ref names, and an issue with no fix', () => {
    const parsed = parseFlowIssues(
      answer({
        issues: [
          { scene: 'n3', quote: 'She teh sea below.', problem: 'Typo.', fix: 'She saw the sea below.' },
          { scene: 'n4', quote: 'Rook waited at the quay', problem: 'Who is Rook?', fix: null }
        ]
      }),
      input()
    )
    expect(parsed.dropped).toBe(0)
    expect(parsed.issues).toEqual([
      {
        category: 'copy',
        nodeId: 'sc-1',
        original: 'She teh sea below.',
        replacement: 'She saw the sea below.',
        rationale: 'Typo.',
        at: normalizeForMatch(ONE).indexOf('She teh')
      },
      {
        category: 'copy',
        nodeId: 'sc-2',
        original: 'Rook waited at the quay',
        replacement: null,
        rationale: 'Who is Rook?',
        at: 0
      }
    ])
  })

  it('finds the scene by the quote when the ref is wrong, and keeps the text’s own casing', () => {
    const parsed = parseFlowIssues(
      answer({ issues: [{ scene: 'n9', quote: '“the tide turned at dusk.”', problem: 'Flat.', fix: null }] }),
      input()
    )
    expect(parsed.issues).toMatchObject([{ nodeId: 'sc-2', original: 'The tide turned at dusk.' }])
  })

  it('drops a quote no scene holds, an issue that says nothing, and an overlap with a kept fix', () => {
    const taken = new Map<string, { at: number; end: number }[]>()
    const parsed = parseFlowIssues(
      answer({
        issues: [
          { scene: 'n3', quote: 'Mara swam out past the breakers', problem: 'x', fix: null },
          { scene: 'n3', quote: 'Mara climbed the ridge alone.', problem: '', fix: null },
          { scene: 'n3', quote: 'She teh sea below.', problem: 'Typo.', fix: 'She saw the sea below.' },
          { scene: 'n3', quote: 'teh sea below', problem: 'Typo again.', fix: null }
        ]
      }),
      input({ taken })
    )
    expect(parsed.issues.map((issue) => issue.original)).toEqual(['She teh sea below.'])
    expect(parsed.dropped).toBe(3)
    expect(taken.get('sc-1')).toHaveLength(1)
  })

  it('a fix that fails the tracked-change rule keeps the issue without it', () => {
    const parsed = parseFlowIssues(
      answer({
        issues: [
          // Same as the quote: nothing to change.
          { scene: 'n3', quote: 'Mara climbed the ridge alone.', problem: 'Fine?', fix: 'Mara climbed the ridge alone.' },
          // An elided quote never carries a fix.
          { scene: 'n4', quote: 'Rook waited … the ledger.', problem: 'Slow.', fix: 'Rook waited.' }
        ]
      }),
      input({ family: 'line' })
    )
    expect(parsed.issues.map((issue) => [issue.category, issue.replacement])).toEqual([
      ['line', null],
      ['line', null]
    ])
  })

  it('Proofreading keeps only corrections; Developmental never carries a fix and gives the overview', () => {
    const proof = parseFlowIssues(
      answer({
        issues: [
          {
            scene: 'n3',
            quote: 'Her eyes were brown as river mud.',
            problem: 'Better phrasing.',
            fix: 'Her eyes, the brown of the river after rain, watched the water.'
          }
        ]
      }),
      input({ family: 'proof' })
    )
    expect(proof.issues).toMatchObject([{ category: 'proofread', replacement: null }])

    const dev = parseFlowIssues(
      answer({
        overview: '  Strong opening; the middle sags.  ',
        issues: [{ scene: 'n4', quote: 'The tide turned at dusk.', problem: 'Nothing turns.', fix: 'x' }]
      }),
      input({ family: 'developmental' })
    )
    expect(dev.overview).toBe('Strong opening; the middle sags.')
    expect(dev.issues).toMatchObject([{ category: 'developmental', replacement: null }])
  })

  it('the checks family files each issue under the check it names, or the only one asked', () => {
    const both = parseFlowIssues(
      answer({
        issues: [
          { scene: 'n3', check: 'continuity', quote: 'Her eyes were brown as river mud.', problem: 'Grey in p1.', fix: 'Her eyes were grey as river mud.' },
          { scene: 'n4', check: 'nonsense', quote: 'Rook waited at the quay', problem: 'x', fix: null }
        ]
      }),
      input({ family: 'checks', checks: ['continuity', 'voice'] })
    )
    expect(both.issues.map((issue) => issue.category)).toEqual(['continuity'])
    expect(both.dropped).toBe(1)
    const one = parseFlowIssues(
      answer({ issues: [{ scene: 'n4', quote: 'Rook waited at the quay', problem: 'Off.', fix: null }] }),
      input({ family: 'checks', checks: ['voice'] })
    )
    expect(one.issues.map((issue) => issue.category)).toEqual(['voice'])
  })

  it('an answer that is not the issues JSON is a fallback error', () => {
    expect(() => parseFlowIssues('not json', input())).toThrow(AiFallbackError)
    expect(() => parseFlowIssues(answer({ changes: [] }), input())).toThrow(AiFallbackError)
  })
})

describe('parseFlowNotes (Update notes)', () => {
  it('reads appends and new pages, drops blanks, and stops at the cap', () => {
    const parsed = parseFlowNotes(
      answer({
        notes: [
          { page: 'p2', add: 'Fears the sea.' },
          { title: 'Rook', folder: 'Characters', text: 'Waits at the quay.' },
          { page: 'p3', add: '  ' },
          'nonsense',
          ...Array.from({ length: 10 }, (_, i) => ({ page: 'p1', add: `Line ${i}` }))
        ]
      })
    )
    expect(parsed.writes.slice(0, 2)).toEqual([
      { kind: 'append', page: 'p2', text: 'Fears the sea.' },
      { kind: 'create', title: 'Rook', folder: 'Characters', text: 'Waits at the quay.' }
    ])
    expect(parsed.writes).toHaveLength(8)
    expect(parsed.dropped).toBe(6)
  })
})

describe('parseFlowNotes timeline events (editNotes.v2, the notes binder)', () => {
  it('reads each event as one line with the line it follows, drops blanks and stops at the cap', () => {
    const parsed = parseFlowNotes(
      answer({
        notes: [],
        timeline: [
          { line: 'Ch 2 ·  Rook meets\nMara.', after: 'Ch 1 · Mara reaches the quay.' },
          { line: 'Ch 0 · The river freezes.', after: '' },
          { line: 'Ch 4 · The mill burns.' },
          { line: '   ', after: '' },
          'nonsense',
          ...Array.from({ length: EDIT_FLOW_TIMELINE_EVENTS_MAX }, (_, i) => ({
            line: `Ch 9 · Event ${i}`,
            after: null
          }))
        ]
      })
    )
    expect(parsed.events.slice(0, 3)).toEqual([
      { line: 'Ch 2 · Rook meets Mara.', after: 'Ch 1 · Mara reaches the quay.' },
      { line: 'Ch 0 · The river freezes.', after: '' },
      { line: 'Ch 4 · The mill burns.', after: null }
    ])
    expect(parsed.events).toHaveLength(EDIT_FLOW_TIMELINE_EVENTS_MAX)
    expect(parsed.dropped).toBe(2 + 3)
    expect(parseFlowNotes(answer({ notes: [] })).events).toEqual([])
  })
})

