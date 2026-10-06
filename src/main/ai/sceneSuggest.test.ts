import { describe, expect, it } from 'vitest'
import { SCENE_SYNOPSIS_MAX } from '@shared/sceneMeta'
import { NOTES_SUGGEST_POINT_MAX, NOTES_SUGGEST_POINTS_MAX } from '@shared/sceneSuggest'
import { AiFallbackError } from './providers/types'
import { parseNotesSuggestAnswer, parseSynopsisAnswer } from './sceneSuggest'

describe('parseSynopsisAnswer (F-5.20)', () => {
  it('trims, collapses whitespace, and cuts to the synopsis cap', () => {
    expect(parseSynopsisAnswer('{"synopsis":"  Mara waits.\\n\\nTomas comes late.  "}')).toBe(
      'Mara waits. Tomas comes late.'
    )
    const long = parseSynopsisAnswer(
      JSON.stringify({ synopsis: 'a'.repeat(SCENE_SYNOPSIS_MAX + 20) })
    )
    expect(long).toHaveLength(SCENE_SYNOPSIS_MAX)
  })

  it('is a PROVIDER failure for non-JSON, the wrong shape, or a blank synopsis', () => {
    for (const text of ['nope', '{"summary":"x"}', '{"synopsis":"   "}', '{"synopsis":3}']) {
      expect(() => parseSynopsisAnswer(text)).toThrowError(AiFallbackError)
    }
  })
})

describe('parseNotesSuggestAnswer (F-5.20)', () => {
  it('keeps the points trimmed and capped, and counts the blank, repeated, and wrong-shaped ones', () => {
    const answer = JSON.stringify({
      points: [
        ' Tomas has the ledger copy. ',
        '',
        'Tomas has the ledger copy.',
        42,
        'p'.repeat(NOTES_SUGGEST_POINT_MAX + 10)
      ]
    })
    expect(parseNotesSuggestAnswer(answer)).toEqual({
      points: ['Tomas has the ledger copy.', 'p'.repeat(NOTES_SUGGEST_POINT_MAX)],
      dropped: 3
    })
  })

  it('stops at the points cap and counts the rest as dropped', () => {
    const points = Array.from({ length: NOTES_SUGGEST_POINTS_MAX + 2 }, (_, i) => `Point ${i}`)
    const parsed = parseNotesSuggestAnswer(JSON.stringify({ points }))
    expect(parsed.points).toHaveLength(NOTES_SUGGEST_POINTS_MAX)
    expect(parsed.dropped).toBe(2)
  })

  it('is a PROVIDER failure for non-JSON or no points array', () => {
    for (const text of ['nope', '{"notes":[]}', '{"points":"x"}']) {
      expect(() => parseNotesSuggestAnswer(text)).toThrowError(AiFallbackError)
    }
  })
})
