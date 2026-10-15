import { describe, expect, it } from 'vitest'
import { checkQuote, checkQuotes } from './quotes'

const SCENE = [
  'Tash climbed the ridge alone. “The sea,” she said, “is the colour of old knives.”',
  'Below, the quay   was empty.\nRook had gone.'
].join('\n\n')

describe('checkQuote (Ms Scribe’s quotes, checked locally)', () => {
  it('keeps a quote the scene holds, as the scene has it once normalized', () => {
    expect(checkQuote(SCENE, 'Tash climbed the ridge alone.')).toBe('Tash climbed the ridge alone.')
    // Curly quotes straightened, whitespace runs and paragraph breaks one space.
    expect(checkQuote(SCENE, '"The sea," she said')).toBe('The sea," she said')
    expect(checkQuote(SCENE, 'the quay was empty. Rook had gone')).toBe(
      'the quay was empty. Rook had gone'
    )
  })

  it('drops a quote the scene does not hold, or one too short to be a spot', () => {
    expect(checkQuote(SCENE, 'Tash climbed the mountain alone.')).toBeNull()
    expect(checkQuote(SCENE, 'Rook')).toBeNull()
    expect(checkQuote(SCENE, '')).toBeNull()
    expect(checkQuote('', 'Tash climbed the ridge')).toBeNull()
  })

  it('corrects her casing to the scene’s and drops the marks and ellipses around a quote', () => {
    expect(checkQuote(SCENE, 'tash CLIMBED the ridge')).toBe('Tash climbed the ridge')
    expect(checkQuote(SCENE, '“…Tash climbed the ridge alone…”')).toBe(
      'Tash climbed the ridge alone'
    )
    expect(checkQuote(SCENE, '...the quay was empty...')).toBe('the quay was empty')
  })

  it('keeps the longest piece of a quote she elided inside', () => {
    expect(checkQuote(SCENE, 'Tash climbed … is the colour of old knives')).toBe(
      'is the colour of old knives'
    )
    expect(checkQuote(SCENE, 'Tash flew ... the colour of rain')).toBeNull()
  })
})

describe('checkQuotes', () => {
  it('keeps those found, each once, at most max', () => {
    expect(
      checkQuotes(
        SCENE,
        [
          'Rook had gone',
          'not in the scene at all',
          'rook had gone',
          'Tash climbed',
          'the ridge alone'
        ],
        2
      )
    ).toEqual(['Rook had gone', 'Tash climbed'])
  })
})
