import { describe, expect, it } from 'vitest'
import { normalizeForMatch } from '../critique'
import {
  QUOTE_MAX_WORDS,
  QUOTE_MIN_WORDS,
  locateQuote,
  normalizeWithOffsets,
  quoteWordCount
} from './quote'

const WINDOW = [
  'Mara climbed the ridge at dusk. Her eyes were grey in the failing light.',
  'Tomas waited below.  He had the map, and he did not\nlike the wind.',
  '“You are late,” said Tomas. Mara did not answer.'
]

describe('normalizeWithOffsets', () => {
  it('produces normalizeForMatch text and maps every character back', () => {
    const text = '  “Go,”\n she   said.  '
    const normalized = normalizeWithOffsets(text)
    expect(normalized.text).toBe(normalizeForMatch(text))
    expect(normalized.offsets).toHaveLength(normalized.text.length)
    expect(text[normalized.offsets[0] ?? -1]).toBe('“')
    expect(text[normalized.offsets[normalized.text.length - 1] ?? -1]).toBe('.')
  })
})

describe('locateQuote (F-16.3, the ladder’s Presence step)', () => {
  it('finds a quote once in its paragraph, with offsets in the paragraph’s own text and its sentences', () => {
    const located = locateQuote(WINDOW, 0, 'Her eyes were grey')
    expect(located).toEqual({
      ok: true,
      p: 0,
      start: WINDOW[0]?.indexOf('Her eyes') ?? -1,
      end: (WINDOW[0]?.indexOf('Her eyes') ?? 0) + 'Her eyes were grey'.length,
      sentences: [1]
    })
  })

  it('matches across collapsed whitespace and line breaks, and spans two sentences', () => {
    const located = locateQuote(WINDOW, 1, 'Tomas waited below. He had the map')
    expect(located).toMatchObject({ ok: true, p: 1, sentences: [0, 1] })
    if (located.ok) {
      expect(WINDOW[1]?.slice(located.start, located.end)).toBe(
        'Tomas waited below.  He had the map'
      )
    }
    expect(locateQuote(WINDOW, 1, 'he did not like the wind')).toMatchObject({ ok: true })
  })

  it('reads curly quotes in the text as straight ones', () => {
    expect(locateQuote(WINDOW, 2, '"You are late," said Tomas.')).toMatchObject({
      ok: true,
      sentences: [0]
    })
  })

  it('refuses a quote outside 3–25 words', () => {
    expect(QUOTE_MIN_WORDS).toBe(3)
    expect(QUOTE_MAX_WORDS).toBe(25)
    expect(locateQuote(WINDOW, 0, 'grey eyes')).toEqual({ ok: false, reason: 'tooShort' })
    expect(quoteWordCount('  one  two\nthree ')).toBe(3)
    const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(' ')
    expect(locateQuote([long], 0, long)).toEqual({ ok: false, reason: 'tooLong' })
  })

  it('reports a quote that is not in the window, and matches case-sensitively', () => {
    expect(locateQuote(WINDOW, 0, 'Her eyes were blue')).toEqual({ ok: false, reason: 'notFound' })
    expect(locateQuote(WINDOW, 0, 'her eyes were grey')).toEqual({ ok: false, reason: 'notFound' })
  })

  it('reports a quote that occurs twice as repeated, even when one is in the named paragraph', () => {
    const window = ['He looked at the sea.', 'Later, he looked at the sea again.']
    // Case-sensitive: the lowercase form is only in the second paragraph.
    expect(locateQuote(window, 0, 'he looked at the sea')).toEqual({
      ok: false,
      reason: 'otherParagraph'
    })
    expect(locateQuote(window, 0, 'looked at the sea')).toEqual({ ok: false, reason: 'repeated' })
    expect(locateQuote(['the bell rang and the bell rang'], 0, 'the bell rang')).toEqual({
      ok: false,
      reason: 'repeated'
    })
  })

  it('reports a quote found once in another paragraph as otherParagraph', () => {
    expect(locateQuote(WINDOW, 0, 'Tomas waited below')).toEqual({
      ok: false,
      reason: 'otherParagraph'
    })
  })

  it('matches on word boundaries only', () => {
    expect(locateQuote(['Moran homeward bound.'], 0, 'ran homeward bound')).toEqual({
      ok: false,
      reason: 'notFound'
    })
  })
})
