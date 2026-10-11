import { describe, expect, it } from 'vitest'
import {
  SENTENCE_HASH_LENGTH,
  anchorFor,
  anchorHolds,
  sceneSentences,
  sentenceHash
} from './anchor'
import { locateQuote } from './quote'

const SCENE = [
  'Mara climbed the ridge at dusk. Her eyes were grey in the failing light.',
  'Tomas waited below. He had the map.',
  'She did not look back. The wind rose.'
]

function hashes(paragraphs: readonly string[]): Set<string> {
  return new Set(sceneSentences(paragraphs).map((sentence) => sentence.hash))
}

describe('sentenceHash', () => {
  it('is 14 hex characters, stable, and blind to whitespace and quote style', () => {
    const hash = sentenceHash('“Go,” she said.')
    expect(hash).toMatch(new RegExp(`^[0-9a-f]{${SENTENCE_HASH_LENGTH}}$`))
    expect(sentenceHash('"Go,"  she\nsaid.')).toBe(hash)
    expect(sentenceHash('"Go," she said!')).not.toBe(hash)
    // Names stay in the hash: renaming a character changes it (Rename in book rewrites anchors).
    expect(sentenceHash('Mara ran.')).not.toBe(sentenceHash('Rynna ran.'))
  })
})

describe('sceneSentences', () => {
  it('lists every sentence with its paragraph and index', () => {
    const sentences = sceneSentences(SCENE)
    expect(sentences.map((s) => [s.p, s.index])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1]
    ])
    expect(sentences[1]?.text).toBe('Her eyes were grey in the failing light.')
  })
})

describe('anchorFor and anchorHolds (F-16.3)', () => {
  const sentences = sceneSentences(SCENE)

  it('anchors the quote’s sentence with one either side, across paragraph boundaries', () => {
    const located = locateQuote(SCENE, 0, 'Her eyes were grey')
    if (!located.ok) throw new Error('quote not located')
    const anchor = anchorFor(sentences, located)
    // Sentence 0.1 plus 0.0 before it and 1.0 after it, in the next paragraph.
    expect(anchor).toEqual([sentences[0]?.hash, sentences[1]?.hash, sentences[2]?.hash])
    expect(anchorHolds(anchor, hashes(SCENE))).toBe(true)
  })

  it('adds the naming sentence for a pronoun subject', () => {
    const located = locateQuote(SCENE, 2, 'She did not look back')
    if (!located.ok) throw new Error('quote not located')
    const anchor = anchorFor(sentences, located, 0)
    expect(anchor).toEqual([
      sentences[0]?.hash,
      sentences[3]?.hash,
      sentences[4]?.hash,
      sentences[5]?.hash
    ])
  })

  it('breaks only the anchors that cover an edited sentence', () => {
    const first = locateQuote(SCENE, 0, 'Her eyes were grey')
    const last = locateQuote(SCENE, 2, 'The wind rose')
    if (!first.ok || !last.ok) throw new Error('quote not located')
    const early = anchorFor(sentences, first)
    const late = anchorFor(sentences, last)
    // Editing the first sentence of the scene: only the early claim's proof moved.
    const edited = [
      'Mara climbed the ridge at nightfall. Her eyes were grey in the failing light.',
      ...SCENE.slice(1)
    ]
    expect(anchorHolds(early, hashes(edited))).toBe(false)
    expect(anchorHolds(late, hashes(edited))).toBe(true)
    // Re-flowing whitespace is not an edit.
    expect(anchorHolds(early, hashes(SCENE.map((p) => p.replace(/ /g, '  '))))).toBe(true)
  })

  it('is empty for a location that names no sentence, and an empty anchor always holds', () => {
    expect(anchorFor(sentences, { p: 9, sentences: [0] })).toEqual([])
    expect(anchorHolds([], new Set())).toBe(true)
  })
})
