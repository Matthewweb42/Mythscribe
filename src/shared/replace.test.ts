import { describe, expect, it } from 'vitest'
import {
  REPLACEMENT_MAX,
  REPLACE_QUERY_MAX,
  REPLACE_SAMPLES,
  ReplaceCommitRequest,
  ReplaceRequest,
  countInDoc,
  findInRun,
  isReplaceable,
  replaceInDoc,
  samplesInDoc,
  type ReplaceOptions
} from './replace'
import type { TiptapMarkT, TiptapNodeT } from './tiptap'

const options = (
  query: string,
  replacement: string,
  patch: Partial<ReplaceOptions> = {}
): ReplaceOptions => ({ query, replacement, matchCase: false, wholeWord: false, ...patch })

const text = (value: string, ...marks: TiptapMarkT[]): TiptapNodeT =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value }

const paragraph = (...content: (string | TiptapNodeT)[]): TiptapNodeT => ({
  type: 'paragraph',
  content: content.map((child) => (typeof child === 'string' ? text(child) : child))
})

const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

const BOLD: TiptapMarkT = { type: 'bold' }
const ITALIC: TiptapMarkT = { type: 'italic' }
const AI: TiptapMarkT = { type: 'aiOrigin', attrs: { proposalId: 'p-1' } }
const TOKEN: TiptapNodeT = { type: 'inlineTag', attrs: { id: 't-1', name: 'rose' } }
const BREAK: TiptapNodeT = { type: 'hardBreak' }

/** A deep copy that shares nothing with its source, to prove an input was not mutated. */
const snapshot = (node: TiptapNodeT): unknown => JSON.parse(JSON.stringify(node))

describe('replace request shapes (F-10.2)', () => {
  it('accepts an empty query and an empty replacement, and refuses anything over the limits', () => {
    const base = { query: '', replacement: '', matchCase: false, wholeWord: false, scopeId: null }
    expect(ReplaceRequest.safeParse(base).success).toBe(true)
    expect(
      ReplaceRequest.safeParse({ ...base, query: 'x'.repeat(REPLACE_QUERY_MAX + 1) }).success
    ).toBe(false)
    expect(
      ReplaceRequest.safeParse({ ...base, replacement: 'x'.repeat(REPLACEMENT_MAX + 1) }).success
    ).toBe(false)
    expect(ReplaceCommitRequest.safeParse(base).success).toBe(false)
    expect(ReplaceCommitRequest.safeParse({ ...base, ids: ['a'] }).success).toBe(true)
  })

  it('only an empty query cannot be replaced; whitespace is a fair query', () => {
    expect(isReplaceable({ query: '' })).toBe(false)
    expect(isReplaceable({ query: '  ' })).toBe(true)
    expect(isReplaceable({ query: 'a' })).toBe(true)
  })
})

describe('findInRun', () => {
  it('matches case-insensitively unless Match case is on', () => {
    expect(findInRun('The Lantern and the lantern', options('lantern', ''))).toEqual([
      [4, 11],
      [20, 27]
    ])
    expect(
      findInRun('The Lantern and the lantern', options('lantern', '', { matchCase: true }))
    ).toEqual([[20, 27]])
    expect(findInRun('lantern', options('LANTERN', '', { matchCase: true }))).toEqual([])
  })

  it('finds nothing for an empty query', () => {
    expect(findInRun('anything', options('', 'x'))).toEqual([])
  })

  it('does not collapse whitespace: two spaces are two spaces', () => {
    expect(findInRun('a  b a b', options('a b', ''))).toEqual([[5, 8]])
    expect(findInRun('a  b', options('  ', ' '))).toEqual([[1, 3]])
  })

  it('lets straight and curly quotes match each other, with Match case too', () => {
    expect(findInRun('She said “don’t”.', options('"don\'t"', ''))).toEqual([[9, 16]])
    expect(findInRun("don't", options('don’t', '', { matchCase: true }))).toEqual([[0, 5]])
  })

  it('whole word refuses a match touching a letter, a digit, or an underscore of any script', () => {
    const whole = (haystack: string, query: string): [number, number][] =>
      findInRun(haystack, options(query, '', { wholeWord: true }))
    expect(whole('Rose and Rosemary, rose.', 'rose')).toEqual([
      [0, 4],
      [19, 23]
    ])
    expect(whole('rose2 rose_ _rose 2rose', 'rose')).toEqual([])
    expect(whole('élan, élancé', 'élan')).toEqual([[0, 4]])
    expect(whole('красный кот, котик', 'кот')).toEqual([[8, 11]])
    // An astral letter (two UTF-16 units) on either side still counts as a letter.
    expect(whole('𝒜rose rose𝒜', 'rose')).toEqual([])
    // A combining mark belongs to the word before it.
    expect(whole('café cafe', 'cafe')).toEqual([[6, 10]])
    expect(whole('(rose)', 'rose')).toEqual([[1, 5]])
  })

  it('never overlaps, and a refused whole-word candidate does not hide a later one', () => {
    expect(findInRun('aaaa', options('aa', ''))).toEqual([
      [0, 2],
      [2, 4]
    ])
    expect(findInRun('aaa', options('aa', ''))).toEqual([[0, 2]])
    // "a a" at 1 is refused (preceded by "x"); the one at 3 overlaps it and is valid.
    expect(findInRun('xa a a', options('a a', '', { wholeWord: true }))).toEqual([[3, 6]])
  })

  it('keeps offsets when a character has a longer lowercase form', () => {
    expect(findInRun('İ lantern', options('lantern', ''))).toEqual([[2, 9]])
  })
})

describe('replaceInDoc: matching', () => {
  it('replaces every occurrence and counts them', () => {
    const source = doc(paragraph('The lantern swung.'), paragraph('A Lantern, a lantern.'))
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.count).toBe(3)
    expect(result.doc).toEqual(doc(paragraph('The lamp swung.'), paragraph('A lamp, a lamp.')))
  })

  it('never matches across a block boundary, so paragraphs are never merged', () => {
    const source = doc(paragraph('storm'), paragraph('broke'))
    for (const query of ['stormbroke', 'storm broke', 'storm\nbroke']) {
      const result = replaceInDoc(source, options(query, 'x'))
      expect(result.count).toBe(0)
      expect(result.doc).toBe(source)
    }
  })

  it('treats a hard break and an inline tag token as boundaries, and leaves them in place', () => {
    const source = doc(paragraph('storm', BREAK, 'broke'), paragraph('storm', TOKEN, 'broke'))
    expect(replaceInDoc(source, options('stormbroke', 'x')).count).toBe(0)
    const result = replaceInDoc(source, options('broke', 'ended'))
    expect(result.count).toBe(2)
    expect(result.doc).toEqual(
      doc(paragraph('storm', BREAK, 'ended'), paragraph('storm', TOKEN, 'ended'))
    )
    // The token's own name is not text: it is never replaced.
    expect(replaceInDoc(source, options('rose', 'x')).count).toBe(0)
  })

  it('a token beside a match counts as a word boundary', () => {
    const source = doc(paragraph('rose', TOKEN, 'rose'))
    expect(replaceInDoc(source, options('rose', 'x', { wholeWord: true })).count).toBe(2)
  })

  it('deletes with an empty replacement and stores an emptied block without content', () => {
    const source = doc(paragraph('gone'), paragraph('all gone now'))
    const result = replaceInDoc(source, options('gone', ''))
    expect(result.count).toBe(2)
    expect(result.doc).toEqual(doc({ type: 'paragraph' }, paragraph('all  now')))
  })

  it('never scans the replacement again', () => {
    const result = replaceInDoc(doc(paragraph('a banana')), options('a', 'aa'))
    expect(result.count).toBe(4)
    expect(result.doc).toEqual(doc(paragraph('aa baanaanaa')))
    expect(replaceInDoc(doc(paragraph('xx')), options('x', 'xyx')).doc).toEqual(
      doc(paragraph('xyxxyx'))
    )
  })

  it('takes the replacement literally: no `$1`, no `$&`, no case preservation', () => {
    const result = replaceInDoc(doc(paragraph('Lantern')), options('lantern', '$& $1 lamp'))
    expect(result.doc).toEqual(doc(paragraph('$& $1 lamp')))
  })

  it('reaches text nested in other blocks', () => {
    const source = doc(
      { type: 'blockquote', content: [paragraph('a lantern')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('Lantern')] },
      { type: 'sceneBreak' }
    )
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.count).toBe(2)
    expect(result.doc).toEqual(
      doc(
        { type: 'blockquote', content: [paragraph('a lamp')] },
        { type: 'heading', attrs: { level: 2 }, content: [text('lamp')] },
        { type: 'sceneBreak' }
      )
    )
  })
})

describe('replaceInDoc: marks', () => {
  it('keeps the marks of the node a match lies in, as one node', () => {
    const source = doc(paragraph('The ', text('bold lantern here', BOLD), ' stays.'))
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.doc).toEqual(doc(paragraph('The ', text('bold lamp here', BOLD), ' stays.')))
  })

  it('gives a match spanning nodes the marks of the node holding its first character', () => {
    const source = doc(paragraph(text('a lan', BOLD), text('te', ITALIC), 'rn b'))
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.count).toBe(1)
    // The italic node held only the middle of the match: it is empty now and removed.
    expect(result.doc).toEqual(doc(paragraph(text('a lamp', BOLD), ' b')))
  })

  it('leaves the remainders of a spanning match with their own marks', () => {
    const source = doc(paragraph(text('one tw', BOLD), text('o three', ITALIC)))
    const result = replaceInDoc(source, options('two', '2'))
    expect(result.doc).toEqual(doc(paragraph(text('one 2', BOLD), text(' three', ITALIC))))
  })

  it('removes a node the match consumed entirely, even with an empty replacement', () => {
    const source = doc(paragraph('a ', text('lantern', BOLD), ' b'))
    expect(replaceInDoc(source, options('lantern', '')).doc).toEqual(doc(paragraph('a ', ' b')))
  })

  it('carries a provenance mark like any other mark', () => {
    const source = doc(paragraph('Mine. ', text('The lantern is AI text.', AI, ITALIC)))
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.doc).toEqual(doc(paragraph('Mine. ', text('The lamp is AI text.', AI, ITALIC))))
    // A match that starts in the author's text and ends in AI text is the author's.
    const spanning = doc(paragraph('my lan', text('tern glows', AI)))
    expect(replaceInDoc(spanning, options('lantern', 'lamp')).doc).toEqual(
      doc(paragraph('my lamp', text(' glows', AI)))
    )
  })

  it('handles several matches in one run of several nodes', () => {
    const source = doc(paragraph(text('ab', BOLD), text('ab', ITALIC), 'ab'))
    const result = replaceInDoc(source, options('ba', '-'))
    expect(result.count).toBe(2)
    expect(result.doc).toEqual(doc(paragraph(text('a-', BOLD), text('-', ITALIC), 'b')))
  })
})

describe('replaceInDoc: identity', () => {
  it('returns the very same document when nothing matches', () => {
    const source = doc(paragraph('nothing here'))
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result).toEqual({ doc: source, count: 0 })
    expect(result.doc).toBe(source)
    expect(replaceInDoc(source, options('', 'lamp')).doc).toBe(source)
  })

  it('never mutates its input and shares the untouched blocks', () => {
    const untouched = paragraph('nothing here')
    const source = doc(untouched, paragraph(text('a lan', BOLD), text('tern', AI)))
    const before = snapshot(source)
    const result = replaceInDoc(source, options('lantern', 'lamp'))
    expect(result.count).toBe(1)
    expect(source).toEqual(before)
    expect(result.doc).not.toBe(source)
    expect(result.doc.content?.[0]).toBe(untouched)
  })
})

describe('countInDoc / samplesInDoc', () => {
  const source = doc(
    paragraph('The lantern swung.'),
    paragraph('A ', text('Lantern', BOLD), ', a lan', text('tern.', ITALIC))
  )

  it('counts exactly what replaceInDoc replaces', () => {
    for (const each of [
      options('lantern', 'lamp'),
      options('lantern', 'lamp', { matchCase: true }),
      options('a', 'b', { wholeWord: true }),
      options('missing', 'x')
    ]) {
      expect(countInDoc(source, each)).toBe(replaceInDoc(source, each).count)
    }
    expect(countInDoc(source, options('lantern', 'lamp'))).toBe(3)
  })

  it('gives one sample per occurrence under the cap, each with the line before and after', () => {
    const each = options('lantern', 'lamp')
    const samples = samplesInDoc(source, each)
    expect(samples).toHaveLength(countInDoc(source, each))
    expect(samples).toEqual([
      {
        before: { text: 'The lantern swung.', range: [4, 11] },
        after: { text: 'The lamp swung.', range: [4, 8] }
      },
      {
        before: { text: 'A Lantern, a lantern.', range: [2, 9] },
        after: { text: 'A lamp, a lantern.', range: [2, 6] }
      },
      {
        before: { text: 'A Lantern, a lantern.', range: [13, 20] },
        after: { text: 'A Lantern, a lamp.', range: [13, 17] }
      }
    ])
  })

  it('stops at the cap while the count goes on', () => {
    const many = doc(paragraph('x '.repeat(REPLACE_SAMPLES + 3)), paragraph('x'))
    const each = options('x', 'y')
    expect(countInDoc(many, each)).toBe(REPLACE_SAMPLES + 4)
    expect(samplesInDoc(many, each)).toHaveLength(REPLACE_SAMPLES)
    expect(samplesInDoc(many, each, 2)).toHaveLength(2)
  })

  it('cuts a long line around the match and keeps the ranges inside the cut', () => {
    const long = `${'word '.repeat(40)}lantern${' word'.repeat(40)}`
    const [sample] = samplesInDoc(doc(paragraph(long)), options('lantern', ''))
    if (sample === undefined) throw new Error('no sample')
    const [from, to] = sample.before.range
    expect(sample.before.text.slice(from, to)).toBe('lantern')
    expect(sample.before.text.startsWith('…')).toBe(true)
    expect(sample.before.text.endsWith('…')).toBe(true)
    expect(sample.after.range).toEqual([from, from])
    expect(sample.after.text).toBe(sample.before.text.replace('lantern', ''))
  })
})
