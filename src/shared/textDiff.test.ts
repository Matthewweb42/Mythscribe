import { describe, expect, it } from 'vitest'
import type { DiffSegment } from './drafts'
import { DIFF_MAX_EDITS, diffWordCount, diffWords } from './textDiff'

const side = (segments: DiffSegment[], keep: 'add' | 'del'): string =>
  segments
    .filter((segment) => segment.op === 'same' || segment.op === keep)
    .map((segment) => segment.text)
    .join('')

describe('diffWords (F-8.5)', () => {
  it('answers one same run for equal texts and nothing for two empty ones', () => {
    expect(diffWords('The storm broke.', 'The storm broke.')).toEqual([
      { op: 'same', text: 'The storm broke.' }
    ])
    expect(diffWords('', '')).toEqual([])
  })

  it('marks a replaced word as del then add, keeping the whitespace in the same runs', () => {
    expect(diffWords('The storm broke at dawn.', 'The squall broke at dawn.')).toEqual([
      { op: 'same', text: 'The ' },
      { op: 'del', text: 'storm' },
      { op: 'add', text: 'squall' },
      { op: 'same', text: ' broke at dawn.' }
    ])
  })

  it('handles pure insertions and deletions, including at the ends', () => {
    expect(diffWords('', 'New text')).toEqual([{ op: 'add', text: 'New text' }])
    expect(diffWords('Old text', '')).toEqual([{ op: 'del', text: 'Old text' }])
    expect(diffWords('She ran.', 'She ran home.')).toEqual([
      { op: 'same', text: 'She ' },
      { op: 'del', text: 'ran.' },
      { op: 'add', text: 'ran home.' }
    ])
    expect(diffWords('one two three', 'one three')).toEqual([
      { op: 'same', text: 'one ' },
      { op: 'del', text: 'two ' },
      { op: 'same', text: 'three' }
    ])
  })

  it('merges adjacent runs of the same op and never returns empty runs', () => {
    const segments = diffWords('a b c d e', 'a x y d e')
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.op).not.toBe(segments[i - 1]?.op)
    }
    for (const segment of segments) expect(segment.text.length).toBeGreaterThan(0)
  })

  it('always joins back to both texts verbatim', () => {
    const pairs: [string, string][] = [
      ['The lantern swung.\nShe raised it.', 'The lamp swung.\n\nShe raised it high.'],
      ['a b a b a b', 'b a b a b a'],
      ['  leading and trailing  ', 'leading, and trailing'],
      ['Mara walked to the gate and waited.', 'Mara waited at the gate, then walked.']
    ]
    for (const [a, b] of pairs) {
      const segments = diffWords(a, b)
      expect(side(segments, 'del')).toBe(a)
      expect(side(segments, 'add')).toBe(b)
    }
  })

  it('finds a shortest script: one moved word costs one delete and one add', () => {
    const segments = diffWords('alpha beta gamma delta', 'beta gamma delta alpha')
    expect(diffWordCount(segments, 'del')).toBe(1)
    expect(diffWordCount(segments, 'add')).toBe(1)
  })

  it('falls back to one del and one add run past the edit cap, still verbatim', () => {
    const many = DIFF_MAX_EDITS
    const a = Array.from({ length: many }, (_, i) => `a${i}`).join(' ')
    const b = Array.from({ length: many }, (_, i) => `b${i}`).join(' ')
    const segments = diffWords(`Start ${a} end.`, `Start ${b} end.`)
    expect(segments.map((segment) => segment.op)).toEqual(['same', 'del', 'add', 'same'])
    expect(side(segments, 'del')).toBe(`Start ${a} end.`)
    expect(side(segments, 'add')).toBe(`Start ${b} end.`)
  })
})

describe('diffWordCount (F-8.5)', () => {
  it('counts the words of one op the way countWords counts a text', () => {
    const segments = diffWords('The storm broke at dawn.', 'The cold squall broke.')
    expect(diffWordCount(segments, 'add')).toBe(3)
    expect(diffWordCount(segments, 'del')).toBe(4)
    expect(diffWordCount(segments, 'same')).toBe(1)
    expect(diffWordCount([], 'add')).toBe(0)
  })
})
