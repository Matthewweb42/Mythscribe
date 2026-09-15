import { describe, expect, it } from 'vitest'
import {
  diffWords,
  REWRITE_CONTEXT_CHARS,
  REWRITE_TEXT_MAX,
  REWRITE_TEXT_MIN,
  type DiffSegment
} from './rewrite'

const join = (segments: DiffSegment[], kinds: DiffSegment['kind'][]): string =>
  segments
    .filter((s) => kinds.includes(s.kind))
    .map((s) => s.text)
    .join('')

describe('diffWords (F-14.10)', () => {
  it('reports identical text as one equal segment and empty text as nothing', () => {
    expect(diffWords('She waited.', 'She waited.')).toEqual([
      { kind: 'equal', text: 'She waited.' }
    ])
    expect(diffWords('', '')).toEqual([])
  })

  it('reconstructs both sides: equal + del is the before, equal + ins is the after', () => {
    const before = 'The ferry landing was empty when Mara reached it, a very quiet place.'
    const after = 'The landing was empty when Mara reached it. Quiet.'
    const diff = diffWords(before, after)
    expect(join(diff, ['equal', 'del'])).toBe(before)
    expect(join(diff, ['equal', 'ins'])).toBe(after)
  })

  it('marks a replaced word as a deletion followed by an insertion, at word granularity', () => {
    expect(diffWords('She walked slowly home.', 'She walked quickly home.')).toEqual([
      { kind: 'equal', text: 'She walked ' },
      { kind: 'del', text: 'slowly' },
      { kind: 'ins', text: 'quickly' },
      { kind: 'equal', text: ' home.' }
    ])
  })

  it('handles pure insertions and pure deletions', () => {
    expect(diffWords('She waited.', 'She waited in the dark.')).toEqual([
      { kind: 'equal', text: 'She waited' },
      { kind: 'ins', text: ' in the dark' },
      { kind: 'equal', text: '.' }
    ])
    expect(diffWords('She waited in the dark.', 'She waited.')).toEqual([
      { kind: 'equal', text: 'She waited' },
      { kind: 'del', text: ' in the dark' },
      { kind: 'equal', text: '.' }
    ])
  })

  it('never emits two adjacent segments of the same kind', () => {
    const diff = diffWords(
      'One two three four five six seven.',
      'One 2 three 4 five 6 seven, eight.'
    )
    for (let i = 1; i < diff.length; i++) {
      expect(diff[i]?.kind).not.toBe(diff[i - 1]?.kind)
    }
  })

  it('keeps paragraph breaks and apostrophes inside words', () => {
    const before = "Tomas didn't move.\n\nShe did."
    const after = "Tomas didn't move.\n\nShe did not."
    const diff = diffWords(before, after)
    expect(join(diff, ['equal', 'del'])).toBe(before)
    expect(join(diff, ['equal', 'ins'])).toBe(after)
    expect(diff.find((s) => s.kind === 'ins')?.text).toBe(' not')
  })

  it('diffs a passage at the size limit in well under a second', () => {
    const before = 'word '.repeat(REWRITE_TEXT_MAX / 5).trim()
    const after = before.replace(/word/g, (w, offset: number) => (offset % 7 === 0 ? 'term' : w))
    const start = performance.now()
    const diff = diffWords(before, after)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(join(diff, ['equal', 'ins'])).toBe(after)
  })
})

describe('rewrite limits', () => {
  it('bound a selection to a sentence at least and ~1,000 tokens at most, with a short context window', () => {
    expect(REWRITE_TEXT_MIN).toBe(20)
    expect(REWRITE_TEXT_MAX).toBe(4_000)
    expect(REWRITE_CONTEXT_CHARS).toBe(300)
    expect(REWRITE_CONTEXT_CHARS).toBeLessThan(REWRITE_TEXT_MAX)
  })
})
