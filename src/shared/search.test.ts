import { describe, expect, it } from 'vitest'
import {
  SEARCH_QUERY_MAX,
  SEARCH_TYPES,
  SEARCH_TYPE_LABEL,
  SearchRequest,
  buildSnippet,
  findOccurrences,
  foldCase,
  isSearchable,
  normalizeQuery,
  searchableText
} from './search'

describe('search vocabulary (F-10.1)', () => {
  it('lists the five types with a chip label each', () => {
    expect(SEARCH_TYPES).toEqual(['document', 'notes', 'character', 'setting', 'world'])
    expect(SEARCH_TYPES.map((type) => SEARCH_TYPE_LABEL[type])).toEqual([
      'Documents',
      'Notes',
      'Characters',
      'Settings',
      'World'
    ])
  })

  it('accepts a short query (main answers empty) and refuses one over the maximum', () => {
    expect(SearchRequest.safeParse({ query: 'a', types: [], tagId: null }).success).toBe(true)
    expect(
      SearchRequest.safeParse({ query: 'x'.repeat(SEARCH_QUERY_MAX + 1), types: [], tagId: null })
        .success
    ).toBe(false)
    expect(SearchRequest.safeParse({ query: 'ab', types: ['folder'], tagId: null }).success).toBe(
      false
    )
  })
})

describe('normalizeQuery / searchableText', () => {
  it('trims, collapses whitespace runs, and composes to NFC', () => {
    expect(normalizeQuery('  the \n\t ridge  ')).toBe('the ridge')
    // "e" + combining acute becomes the single composed letter.
    expect(normalizeQuery('café')).toBe('café')
    expect(searchableText('One.\nTwo.\n\nThree.')).toBe('One. Two. Three.')
  })

  it('needs two characters once normalized', () => {
    expect(isSearchable(normalizeQuery(' a '))).toBe(false)
    expect(isSearchable(normalizeQuery('ab'))).toBe(true)
    expect(isSearchable(normalizeQuery('   '))).toBe(false)
  })
})

describe('findOccurrences', () => {
  it('finds every occurrence whatever the case, as offsets into the original', () => {
    const text = 'Rose waited. The rose had closed; ROSE knew.'
    const found = findOccurrences(text, 'rose')
    expect(found).toEqual([
      [0, 4],
      [17, 21],
      [34, 38]
    ])
    expect(found.map(([from, to]) => text.slice(from, to))).toEqual(['Rose', 'rose', 'ROSE'])
    expect(findOccurrences(text, 'ROSE HAD')).toEqual([[17, 25]])
  })

  it('does not overlap occurrences and finds nothing for an empty query', () => {
    expect(findOccurrences('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4]
    ])
    expect(findOccurrences('anything', '')).toEqual([])
    expect(findOccurrences('', 'ab')).toEqual([])
  })

  it('matches non-ASCII letters case-insensitively', () => {
    const text = 'Élodie crossed the Übergang; élodie did not look back.'
    expect(findOccurrences(text, 'élodie').map(([from, to]) => text.slice(from, to))).toEqual([
      'Élodie',
      'élodie'
    ])
    expect(findOccurrences(text, 'übergang')).toEqual([[19, 27]])
  })

  it('keeps the offsets right after a letter whose lowercase form is longer (İ)', () => {
    // 'İ'.toLowerCase() is two code units; folding the whole string would shift everything after it.
    expect('İ'.toLowerCase()).toHaveLength(2)
    const text = 'İstanbul at dawn, then Dawn again.'
    expect(foldCase(text)).toHaveLength(text.length)
    const found = findOccurrences(text, 'dawn')
    expect(found.map(([from, to]) => text.slice(from, to))).toEqual(['dawn', 'Dawn'])
    expect(findOccurrences(text, 'İstanbul')).toEqual([[0, 8]])
  })
})

describe('buildSnippet', () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')

  it('returns a short text whole, with every occurrence highlighted', () => {
    const text = 'The rose and the Rose.'
    const snippet = buildSnippet(text, findOccurrences(text, 'rose'))
    expect(snippet).toEqual({
      text,
      highlights: [
        [4, 8],
        [17, 21]
      ]
    })
  })

  it('cuts both sides at word boundaries with ellipses, and shifts the highlights', () => {
    const text = `${words} needle ${words}`
    const occurrences = findOccurrences(text, 'needle')
    const snippet = buildSnippet(text, occurrences, 20)
    expect(snippet.text.startsWith('…')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    expect(snippet.highlights).toHaveLength(1)
    const [from, to] = snippet.highlights[0]!
    expect(snippet.text.slice(from, to)).toBe('needle')
    // No partial word on either side: every piece is a whole word of the original.
    const inner = snippet.text.slice(1, -1)
    for (const piece of inner.split(' ')) expect(piece).toMatch(/^(word\d+|needle)$/)
    expect(text).toContain(inner)
    expect(inner.length).toBeLessThanOrEqual('needle'.length + 40)
  })

  it('adds no ellipsis on a side that reaches the edge of the text', () => {
    const start = buildSnippet(`needle ${words}`, [[0, 6]], 20)
    expect(start.text.startsWith('needle')).toBe(true)
    expect(start.text.endsWith('…')).toBe(true)
    expect(start.highlights).toEqual([[0, 6]])
    const text = `${words} needle`
    const end = buildSnippet(text, findOccurrences(text, 'needle'), 20)
    expect(end.text.startsWith('…')).toBe(true)
    expect(end.text.endsWith('needle')).toBe(true)
  })

  it('highlights the later occurrences that fit, and leaves out the ones that were cut', () => {
    const text = `rose red rose ${words} rose`
    const snippet = buildSnippet(text, findOccurrences(text, 'rose'), 20)
    expect(snippet.highlights.map(([from, to]) => snippet.text.slice(from, to))).toEqual([
      'rose',
      'rose'
    ])
  })

  it('keeps a match that sits inside one very long word', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`
    const snippet = buildSnippet(text, findOccurrences(text, 'needle'), 10)
    const [from, to] = snippet.highlights[0]!
    expect(snippet.text.slice(from, to)).toBe('needle')
  })

  it('shows the start of the text, unhighlighted, when there is no occurrence', () => {
    const snippet = buildSnippet(words, [], 20)
    expect(snippet.highlights).toEqual([])
    expect(snippet.text.startsWith('word0 word1')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    expect(snippet.text.length).toBeLessThanOrEqual(41)
    expect(buildSnippet('', [])).toEqual({ text: '', highlights: [] })
  })
})

describe('findOccurrences and quotes (F-10.1)', () => {
  it('finds curly-quoted prose from a straight-quoted query, at the same offsets', () => {
    expect(findOccurrences('She said don’t go.', "don't")).toEqual([[9, 14]])
    expect(findOccurrences("She said don't go.", 'don’t')).toEqual([[9, 14]])
  })
})
