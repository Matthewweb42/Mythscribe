import { describe, expect, it } from 'vitest'
import { capitalisedSpans, caseForm, foldTitles, gateWords, normName } from './names'

const spans = (text: string): [string, boolean][] =>
  capitalisedSpans(text).map((span) => [span.text, span.sentenceStart])

describe('normName (F-16.4)', () => {
  it('folds quotes, full stops, spaces, a possessive and case, and keeps diacritics and titles', () => {
    expect(normName('  Mr.  Harrow’s ')).toBe('mr harrow')
    expect(normName('Mr Harrow')).toBe('mr harrow')
    expect(normName("The Harrows'")).toBe('the harrows')
    expect(normName('René')).toBe('rené')
    expect(normName('René')).not.toBe(normName('Rene'))
    expect(normName('Harrow')).not.toBe(normName('Mr. Harrow'))
  })

  it('keeps the case in caseForm', () => {
    expect(caseForm('the Captain’s')).toBe('the Captain')
    expect(caseForm('Will')).not.toBe(caseForm('will'))
  })
})

describe('title folding (the twin gate only)', () => {
  it('spells each title one way and folds diacritics and possessives', () => {
    expect(gateWords('Capt. René Brand’s')).toEqual(['captain', 'rene', 'brand'])
    expect(gateWords('Mrs. Harrow')).toEqual(gateWords('Mrs Harrow'))
    expect(gateWords('Mister Harrow')).toEqual(gateWords('Mr. Harrow'))
  })

  it('takes the titles and a leading "the" out', () => {
    expect(foldTitles(gateWords('Sir Walter Pell'))).toEqual(['walter', 'pell'])
    expect(foldTitles(gateWords('the Captain'))).toEqual([])
    expect(foldTitles(gateWords('Lady Agatha Strand'))).toEqual(['agatha', 'strand'])
  })
})

describe('capitalisedSpans', () => {
  it('finds the longest capitalised runs, with a title’s full stop inside', () => {
    expect(spans('Then Mr. Harrow and Mrs. Tull met Callum Varrow.')).toEqual([
      ['Then Mr. Harrow', true],
      ['Mrs. Tull', false],
      ['Callum Varrow', false]
    ])
  })

  it('strips a possessive and ends the span there', () => {
    expect(spans('She took Mr. Varrow’s arm and Liesel’s Hat.')).toEqual([
      ['She', true],
      ['Mr. Varrow', false],
      ['Liesel', false],
      ['Hat', false]
    ])
  })

  it('keeps link words inside a span, never at its ends', () => {
    const found = capitalisedSpans('we sailed to the Isle of Skye with Jan van Eyck of the fleet.')
    expect(found.map((span) => span.text)).toEqual(['Isle of Skye', 'Jan van Eyck'])
    expect(found[0]?.words.map((word) => word.link)).toEqual([false, true, false])
  })

  it('flags sentence starts, after quotes and line ends too', () => {
    expect(spans('"Dearest Jo," she wrote. The Captain smiled.\nOld Hobb')).toEqual([
      ['Dearest Jo', true],
      ['The Captain', true],
      ['Old Hobb', true]
    ])
  })

  it('breaks spans at commas and other punctuation', () => {
    expect(spans('Come, Varrow, said Ashby.')).toEqual([
      ['Come', true],
      ['Varrow', false],
      ['Ashby', false]
    ])
  })
})
