import { describe, expect, it } from 'vitest'
import {
  compileFind,
  expandReplacement,
  INVALID_PATTERN,
  PATTERN_TOO_LONG,
  type FindMatch,
  type FindOptions
} from './findInDocument'
import { findInRun, isWholeWordAt, REPLACE_QUERY_MAX } from './replace'

const opts = (query: string, patch: Partial<FindOptions> = {}): FindOptions => ({
  query,
  matchCase: false,
  wholeWord: false,
  regex: false,
  ...patch
})

/** The matched texts, for readable assertions. */
const found = (text: string, options: FindOptions): string[] => {
  const compiled = compileFind(options)
  if (!compiled.ok) throw new Error(compiled.error)
  return compiled.find(text).map(({ from, to }) => text.slice(from, to))
}

const rangesOf = (text: string, options: FindOptions): [number, number][] => {
  const compiled = compileFind(options)
  if (!compiled.ok) throw new Error(compiled.error)
  return compiled.find(text).map(({ from, to }) => [from, to])
}

describe('isWholeWordAt (F-3.10, shared with F-10.2)', () => {
  it('refuses a range touching a word character of any script on either side', () => {
    expect(isWholeWordAt('the cat sat', 4, 7)).toBe(true)
    expect(isWholeWordAt('concat', 3, 6)).toBe(false)
    expect(isWholeWordAt('caté', 0, 3)).toBe(false)
    expect(isWholeWordAt('_cat', 1, 4)).toBe(false)
    expect(isWholeWordAt('"cat"', 1, 4)).toBe(true)
  })
})

describe('compileFind, literal (F-3.10)', () => {
  it('finds exactly what findInRun finds', () => {
    const text = 'The cat’s Cat and concatenate, CAT.'
    for (const patch of [{}, { matchCase: true }, { wholeWord: true }]) {
      const options = opts('cat', patch)
      expect(rangesOf(text, options)).toEqual(findInRun(text, options))
    }
    expect(found(text, opts("cat's"))).toEqual(['cat’s'])
  })

  it('treats regex characters literally and an empty query as nothing', () => {
    expect(found('a.b axb', opts('a.b'))).toEqual(['a.b'])
    expect(found('anything', opts(''))).toEqual([])
  })

  it('refuses a query over the cap', () => {
    expect(compileFind(opts('x'.repeat(REPLACE_QUERY_MAX + 1)))).toEqual({
      ok: false,
      error: PATTERN_TOO_LONG
    })
  })
})

describe('compileFind, regex (F-3.10)', () => {
  it('matches case-insensitively unless Match case is on', () => {
    expect(found('Rain, rain, RAIN', opts('rain', { regex: true }))).toEqual([
      'Rain',
      'rain',
      'RAIN'
    ])
    expect(found('Rain, rain, RAIN', opts('rain', { regex: true, matchCase: true }))).toEqual([
      'rain'
    ])
  })

  it('reports an invalid pattern', () => {
    expect(compileFind(opts('(unclosed', { regex: true }))).toEqual({
      ok: false,
      error: INVALID_PATTERN
    })
  })

  it('skips zero-length matches without looping', () => {
    expect(found('abc', opts('x*', { regex: true }))).toEqual([])
    expect(found('a😀b', opts('(?:)', { regex: true }))).toEqual([])
    expect(found('aab', opts('a*', { regex: true }))).toEqual(['aa'])
  })

  it('straightens quotes in pattern and text, keeping offsets and the curly text in captures', () => {
    const text = 'She said ‘no’ twice.'
    const compiled = compileFind(opts("'(\\w+)'", { regex: true }))
    if (!compiled.ok) throw new Error(compiled.error)
    const [match] = compiled.find(text)
    expect(match && text.slice(match.from, match.to)).toBe('‘no’')
    expect(match?.groups?.numbered).toEqual(['‘no’', 'no'])
  })

  it('applies the whole-word boundary and still finds an overlapping later candidate', () => {
    expect(found('cat concat cats cat', opts('cat', { regex: true, wholeWord: true }))).toEqual([
      'cat',
      'cat'
    ])
    expect(found('aaa a', opts('a+', { regex: true, wholeWord: true }))).toEqual(['aaa', 'a'])
  })

  it('captures named groups', () => {
    const compiled = compileFind(opts('(?<first>\\w+) (?<last>\\w+)', { regex: true }))
    if (!compiled.ok) throw new Error(compiled.error)
    expect(compiled.find('Ada Lovelace')[0]?.groups?.named).toEqual({
      first: 'Ada',
      last: 'Lovelace'
    })
  })

  it('is reusable across runs', () => {
    const compiled = compileFind(opts('o', { regex: true }))
    if (!compiled.ok) throw new Error(compiled.error)
    expect(compiled.find('foo')).toHaveLength(2)
    expect(compiled.find('so')).toHaveLength(1)
  })
})

describe('expandReplacement (F-3.10)', () => {
  const match: FindMatch = {
    from: 0,
    to: 12,
    groups: {
      numbered: ['Ada Lovelace', 'Ada', 'Lovelace', undefined],
      named: { first: 'Ada', last: 'Lovelace' }
    }
  }

  it('takes the replacement literally in literal mode', () => {
    expect(expandReplacement('$1 $&', match, false)).toBe('$1 $&')
  })

  it('expands $&, $n, $<name>, and $$', () => {
    expect(expandReplacement('$2, $1', match, true)).toBe('Lovelace, Ada')
    expect(expandReplacement('[$&]', match, true)).toBe('[Ada Lovelace]')
    expect(expandReplacement('$<last> $<first>', match, true)).toBe('Lovelace Ada')
    expect(expandReplacement('$$1', match, true)).toBe('$1')
  })

  it('follows String.replace for out-of-range groups and stray dollars', () => {
    // $3 exists but did not take part; $12 falls back to $1 then a literal 2; $0 and $9 stay.
    expect(expandReplacement('<$3>', match, true)).toBe('<>')
    expect(expandReplacement('$12', match, true)).toBe('Ada2')
    expect(expandReplacement('$0 $9 $x $', match, true)).toBe('$0 $9 $x $')
    expect(expandReplacement('$<missing>', match, true)).toBe('')
    expect(expandReplacement('$<open', match, true)).toBe('$<open')
  })

  it('leaves $<name> literal when the pattern names no group', () => {
    const plain: FindMatch = { from: 0, to: 1, groups: { numbered: ['a'] } }
    expect(expandReplacement('$<x>', plain, true)).toBe('$<x>')
  })

  it('agrees with String.prototype.replace', () => {
    const re = /(?<first>\w+) (?<last>\w+)(x)?/u
    const text = 'Ada Lovelace'
    for (const template of ['$2, $1', '$&!', '$$', '$<last>', '$12', '$3', '$0']) {
      expect(expandReplacement(template, match, true)).toBe(text.replace(re, template))
    }
  })
})
