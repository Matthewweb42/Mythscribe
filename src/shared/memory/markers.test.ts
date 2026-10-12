import { describe, expect, it } from 'vitest'
import { findMarkers, hasReproofMarker, scopeBackMarkers } from './markers'

const kinds = (text: string): string[] => findMarkers(text).map((hit) => hit.kind)

describe('findMarkers (F-16.17)', () => {
  it('finds each kind on whole words only', () => {
    expect(kinds('She was not there.')).toEqual(['negation'])
    expect(kinds('She wasn’t there.')).toEqual(['negation'])
    expect(kinds('Nobody knew, nothing moved.')).toEqual([])
    expect(kinds('She might go.')).toEqual(['modal'])
    expect(kinds('If she went.')).toEqual(['conditional'])
    expect(kinds('Taller than him.')).toEqual(['comparative'])
    expect(kinds('As tall as him.')).toEqual(['comparative'])
    expect(kinds('Eyes like the sea.')).toEqual(['simile'])
    expect(kinds('She ran as if chased.')).toContain('simile')
    expect(kinds('She liked the sea.')).toEqual([])
    expect(kinds('They said she left.')).toEqual(['reported'])
  })

  it('reads "had" before a participle as pluperfect, and not before an adjective or number', () => {
    expect(kinds('She had once fought a duel.')).toEqual(['pluperfect'])
    expect(kinds('She had been there.')).toEqual(['pluperfect'])
    expect(kinds('She had walked home.')).toEqual(['pluperfect'])
    expect(kinds('She had green eyes.')).toEqual([])
    expect(kinds('She had red hair and ten pounds.')).toEqual([])
    expect(findMarkers('She had walked home.', { ignore: [[4, 7]] })).toEqual([])
  })
})

describe('scope-back markers and the re-proof markers', () => {
  it('finds the markers that reach back over a sentence', () => {
    expect(scopeBackMarkers(', if the letter was true.')).toHaveLength(1)
    expect(scopeBackMarkers(', or so they said.')).toHaveLength(1)
    expect(scopeBackMarkers(', and nobody spoke of how.')).toHaveLength(0)
    expect(scopeBackMarkers(', though he seldom said so.')).toHaveLength(0)
  })

  it('knows the re-proof words', () => {
    expect(hasReproofMarker('She dreamt of it.')).toBe(true)
    expect(hasReproofMarker('He said so.')).toBe(true)
    expect(hasReproofMarker('She didn’t wait.')).toBe(true)
    expect(hasReproofMarker('She waited by the door.')).toBe(false)
  })
})
