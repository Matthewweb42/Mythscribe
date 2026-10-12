import { describe, expect, it } from 'vitest'
import {
  editDistance,
  finishedSentences,
  gateSentences,
  gateText,
  hasClosingPunctuation,
  isCosmetic,
  nextReadSet,
  readDecision,
  readSetOf,
  unreadSentences,
  type GateSentence,
  type ReadEntry
} from './gate'
import { buildNameIndex, type NameIndex } from './nameScan'
import { normName } from './names'

function roster(entries: readonly [string, string][]): NameIndex {
  const records = [...new Set(entries.map(([id]) => id))].map((id) => ({
    id,
    kind: 'character' as const
  }))
  return buildNameIndex(
    records,
    entries.map(([recordId, text], i) => ({
      id: `a${i}`,
      recordId,
      text,
      norm: normName(text),
      caseRule: 'auto' as const,
      shared: false
    }))
  )
}

const NAMES = roster([
  ['mara', 'Mara'],
  ['mara', 'Mara Vell'],
  ['tomas', 'Tomas'],
  ['harrow', 'Mr. Harrow']
])

const SCENE = [
  'Mara climbed the ridge. Her eyes were grey.',
  'Tomas waited below.',
  'She said nothing'
]

const entries = (sentences: readonly GateSentence[]): ReadEntry[] =>
  sentences.map((sentence) => [sentence.hash, sentence.text] as const)

describe('finished sentences (F-16.16)', () => {
  it('counts every sentence, a paragraph’s last one too, and skips the caret paragraph until it closes', () => {
    expect(finishedSentences(SCENE, { caretPara: null }).map((s) => s.text)).toEqual([
      'Mara climbed the ridge.',
      'Her eyes were grey.',
      'Tomas waited below.',
      'She said nothing'
    ])
    expect(finishedSentences(SCENE, { caretPara: 2 }).map((s) => s.para)).toEqual([0, 0, 1])
    // A caret paragraph with closing punctuation counts whole.
    expect(finishedSentences(SCENE, { caretPara: 0 })).toHaveLength(4)
    expect(hasClosingPunctuation('“Go!”')).toBe(true)
    expect(hasClosingPunctuation('He stopped—')).toBe(false)
    expect(hasClosingPunctuation('"But I—"')).toBe(true)
    expect(hasClosingPunctuation('And then')).toBe(false)
  })
})

describe('gateText: names out of the hash (F-16.16)', () => {
  it('replaces roster names, longest first, keeping a possessive outside', () => {
    expect(gateText("Mara Vell's eyes were grey, and Tomas saw.", NAMES)).toBe(
      "⟨mara⟩'s eyes were grey, and ⟨tomas⟩ saw."
    )
    expect(gateText('Mr. Harrow sighed.', NAMES)).toBe('⟨harrow⟩ sighed.')
    expect(gateText('Then Mara ran.', null)).toBe('Then Mara ran.')
  })

  it('reads a renamed scene as unchanged: the gate hash does not move with a name', () => {
    const renamed = roster([
      ['mara', 'Rynna'],
      ['tomas', 'Tomas']
    ])
    const before = gateSentences(['Mara climbed the ridge.'], { caretPara: null, names: NAMES })
    const after = gateSentences(['Rynna climbed the ridge.'], { caretPara: null, names: renamed })
    expect(after[0]?.hash).toBe(before[0]?.hash)
    // A swap of one person for another is a change.
    const swapped = gateSentences(['Tomas climbed the ridge.'], { caretPara: null, names: NAMES })
    expect(swapped[0]?.hash).not.toBe(before[0]?.hash)
  })

  it('matches a name in its case, and a sentence’s first word in either case', () => {
    const will = roster([['will', 'Will']])
    expect(gateText('I will go.', will)).toBe('I will go.')
    expect(gateText('Will went.', will)).toBe('⟨will⟩ went.')
  })

  it('hashes a stored read set again under today’s roster, so a new record changes nothing', () => {
    const scene = ['Hesk drew his knife.']
    const read = entries(gateSentences(scene, { caretPara: null, names: NAMES }))
    const withHesk = roster([
      ['mara', 'Mara'],
      ['hesk', 'Hesk']
    ])
    const now = gateSentences(scene, { caretPara: null, names: withHesk })
    expect(unreadSentences(now, readSetOf(read, withHesk))).toEqual([])
  })
})

describe('the cosmetic skip (F-16.16, P2a-D3)', () => {
  const known = new Set(['the', 'ridge', 'climbed'])

  it('skips whitespace and punctuation only', () => {
    expect(
      isCosmetic('Mara climbed the ridge.', 'Mara  climbed the ridge!', { knownWords: known })
    ).toBe(true)
    expect(isCosmetic('dont go', "don't go", { knownWords: known })).toBe(true)
  })

  it('skips a fix of at most two letters to a word that is not known', () => {
    expect(
      isCosmetic('Mara climbed teh ridge.', 'Mara climbed the ridge.', { knownWords: known })
    ).toBe(true)
    expect(
      isCosmetic('Mara clmbed the ridge.', 'Mara climbed the ridge.', { knownWords: known })
    ).toBe(true)
  })

  it('reads a real word change, a known word changed, or a bigger fix', () => {
    expect(
      isCosmetic('Mara climbed the ridge.', 'Mara climbed the hill.', { knownWords: known })
    ).toBe(false)
    expect(
      isCosmetic('Mara climbed the ridge.', 'Mara climbed the bridge.', { knownWords: known })
    ).toBe(false)
    expect(
      isCosmetic('Mara clmd the ridge.', 'Mara climbed the ridge.', { knownWords: known })
    ).toBe(false)
    expect(isCosmetic('Mara ran.', 'Mara ran home.', { knownWords: known })).toBe(false)
    expect(isCosmetic('⟨mara⟩ ran.', '⟨tomas⟩ ran.', { knownWords: known })).toBe(false)
  })

  it('never reads a changed number as a typo fix', () => {
    expect(
      isCosmetic('It was the spring of 1814.', 'It was the spring of 1815.', { knownWords: known })
    ).toBe(false)
    expect(isCosmetic('She was 19.', 'She was 29.', { knownWords: known })).toBe(false)
  })

  it('counts a transposition as one edit', () => {
    expect(editDistance('teh', 'the')).toBe(1)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('a', 'abcd')).toBe(3)
  })
})

describe('readDecision (F-16.16)', () => {
  const sentences = (
    paragraphs: readonly string[],
    caretPara: number | null = null
  ): GateSentence[] => gateSentences(paragraphs, { caretPara, names: NAMES })
  const base = {
    partials: 0,
    staleParas: new Set<number>(),
    cardStale: false,
    knownWords: new Set<string>()
  }
  const LONG = ['One went.', 'Two went.', 'Three went.', 'Four went.', 'Five went.', 'Six went.']
  const readOf = (paragraphs: readonly string[]): ReturnType<typeof readSetOf> =>
    readSetOf(entries(sentences(paragraphs)), NAMES)

  it('reads a scene first whole, and an empty one never', () => {
    expect(readDecision({ ...base, sentences: sentences(LONG), read: null })).toEqual({
      read: 'full',
      reason: 'first',
      unread: 6
    })
    expect(readDecision({ ...base, sentences: [], read: null })).toMatchObject({
      read: 'nothing',
      reason: 'empty'
    })
  })

  it('reads nothing when nothing changed, or when only a cosmetic edit did', () => {
    const read = readOf(LONG)
    expect(readDecision({ ...base, sentences: sentences(LONG), read })).toMatchObject({
      read: 'nothing',
      reason: 'upToDate'
    })
    const typo = [...LONG.slice(0, 5), 'Six wnet.']
    const fixed = readOf(typo)
    expect(readDecision({ ...base, sentences: sentences(LONG), read: fixed })).toEqual({
      read: 'nothing',
      reason: 'cosmetic',
      unread: 1
    })
    // A cosmetic edit under the card's quotes still reads: the card would quote words now gone.
    expect(
      readDecision({ ...base, cardStale: true, sentences: sentences(LONG), read: fixed })
    ).toEqual({ read: 'window', reason: 'changed', paras: [5], unread: 1 })
  })

  it('reads a window of the changed paragraphs, cosmetic ones beside them included', () => {
    const read = readOf(LONG)
    const now = [...LONG.slice(0, 2), 'Three stayed.', LONG[3] ?? '', LONG[4] ?? '', 'Six  went!']
    expect(readDecision({ ...base, sentences: sentences(now), read })).toEqual({
      read: 'window',
      reason: 'changed',
      paras: [2, 5],
      unread: 2
    })
  })

  it('reads whole when more than half changed, or after five window reads', () => {
    const read = readOf(LONG)
    const now = ['A.', 'B.', 'C.', 'D.', LONG[4] ?? '', LONG[5] ?? '']
    expect(readDecision({ ...base, sentences: sentences(now), read })).toMatchObject({
      read: 'full',
      reason: 'half'
    })
    const one = [...LONG.slice(0, 5), 'Six stayed.']
    expect(readDecision({ ...base, partials: 5, sentences: sentences(one), read })).toMatchObject({
      read: 'full',
      reason: 'partials'
    })
    expect(readDecision({ ...base, partials: 4, sentences: sentences(one), read })).toMatchObject({
      read: 'window'
    })
  })

  it('leaves an unfinished caret paragraph out, and re-checks the paragraphs of stale claims', () => {
    const read = readOf(SCENE.slice(0, 2))
    expect(readDecision({ ...base, sentences: sentences(SCENE, 2), read })).toMatchObject({
      read: 'nothing',
      reason: 'upToDate'
    })
    expect(
      readDecision({ ...base, staleParas: new Set([1]), sentences: sentences(SCENE, 2), read })
    ).toEqual({ read: 'window', reason: 'stale', paras: [1], unread: 0 })
  })
})

describe('nextReadSet', () => {
  it('adds what was sent, keeps what was read, and drops what is gone', () => {
    const before = gateSentences(['One went.', 'Two went.'], { caretPara: null, names: NAMES })
    const now = gateSentences(['One went.', 'Two stayed.', 'Three came.'], {
      caretPara: null,
      names: NAMES
    })
    const previous = readSetOf(entries(before), NAMES)
    const next = nextReadSet(previous, now, new Set([1]))
    expect(next.map(([, text]) => text)).toEqual(['One went.', 'Two stayed.'])
    expect(nextReadSet(previous, now, 'all')).toHaveLength(3)
    expect(nextReadSet(null, now, new Set([2])).map(([, text]) => text)).toEqual(['Three came.'])
  })
})
