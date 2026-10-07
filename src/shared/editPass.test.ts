import { describe, expect, it } from 'vitest'
import { priceFor } from './ai'
import {
  chunksForWords,
  chunkText,
  EDIT_PASS_CHUNK_CHARS,
  EDIT_PASS_CHUNK_OVERHEAD_TOKENS,
  EDIT_PASS_TYPES,
  estimateEditPass,
  passChangesText,
  presetInstruction,
  PRO_RATES_PER_WORD
} from './editPass'

describe('chunkText (F-14.15)', () => {
  it('keeps a short text whole and cuts a long one at paragraph breaks, never losing a word', () => {
    expect(chunkText('One.\n\nTwo.')).toEqual(['One.\n\nTwo.'])
    const paragraph = 'word '.repeat(400).trim()
    const text = Array.from({ length: 10 }, () => paragraph).join('\n\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(EDIT_PASS_CHUNK_CHARS)
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('cuts a single paragraph over the cap at sentence ends', () => {
    const sentence = 'The ferry was late again. '
    const paragraph = sentence.repeat(30).trim()
    const chunks = chunkText(paragraph, 100)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(paragraph)
  })
})

describe('estimateEditPass (F-14.15)', () => {
  it('counts chunks per scene, prices the tokens, and quotes the typical professional range', () => {
    const estimate = estimateEditPass('line', [1_000, 0, 5_000], 'gpt-5.4', 4_000)
    const chunks = chunksForWords(1_000) + chunksForWords(5_000)
    expect(estimate).toMatchObject({ scenes: 2, words: 6_000, chunks })
    expect(estimate.tokensIn).toBe(
      Math.ceil(6_000 * 1.35) + chunks * EDIT_PASS_CHUNK_OVERHEAD_TOKENS
    )
    expect(estimate.costUsd).toBeCloseTo(
      priceFor('gpt-5.4', estimate.tokensIn, estimate.tokensOut).costUsd
    )
    expect(estimate.priced).toBe(true)
    expect(estimate.proLowUsd).toBeCloseTo(6_000 * PRO_RATES_PER_WORD.line.low)
    expect(estimate.proHighUsd).toBeCloseTo(6_000 * PRO_RATES_PER_WORD.line.high)
  })

  it('caps each chunk’s output at the feature budget and marks an unknown model unpriced', () => {
    const estimate = estimateEditPass('custom', [100_000], 'my-local-model', 10)
    expect(estimate.tokensOut).toBe(estimate.chunks * 10)
    expect(estimate).toMatchObject({ costUsd: 0, priced: false })
    expect(estimateEditPass('proofread', [], 'gpt-5.4', 100)).toMatchObject({
      scenes: 0,
      chunks: 0,
      tokensIn: 0,
      costUsd: 0
    })
  })
})

describe('pass types and presets (F-14.15)', () => {
  it('has a professional range for every type, low under high, and only developmental writes no text', () => {
    for (const type of EDIT_PASS_TYPES) {
      expect(PRO_RATES_PER_WORD[type].low).toBeLessThan(PRO_RATES_PER_WORD[type].high)
      expect(passChangesText(type)).toBe(type !== 'developmental')
    }
  })

  it('turns "trim to N words" into the share to cut, and a target above the words into no cut', () => {
    expect(presetInstruction('trimWords', 900, 1_000)).toContain('by about 10%')
    expect(presetInstruction('trimWords', 2_000, 1_000)).toContain('cut only clear redundancy')
    expect(presetInstruction('trimPercent', 15, 1_000)).toContain('by about 15%')
    expect(presetInstruction('dialogue', 0, 0)).toMatch(/^Dialogue pass/)
  })
})
