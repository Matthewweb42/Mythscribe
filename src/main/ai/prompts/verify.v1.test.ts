import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  VERIFY_BATCH_TOKENS,
  VERIFY_PROMPT_VERSION,
  VERIFY_RULES,
  VERIFY_SENTINEL,
  buildVerifyPrompt,
  verifyBatches,
  verifyMaxTokens,
  type VerifyPromptItem
} from './verify.v1'

const items: VerifyPromptItem[] = [
  {
    kind: 'claim',
    who: ['r1 Mara Vell (Mara) · character'],
    fact: 'location: the quay (narration, now)',
    text: "Mara's eyes were grey. She walked to the quay. Tomas was already there, coiling rope."
  },
  {
    kind: 'claim',
    who: ['r1 Mara Vell (Mara) · character', 'r4 Lise Harrow · character'],
    fact: 'eyes: green (narration, now)',
    text: 'Mara and Lise sat by the fire. She had green eyes, and in that light they looked gold.'
  },
  {
    kind: 'pov',
    who: ['r1 Mara Vell (Mara) · character'],
    fact: "the scene is told from r1's point of view",
    text: "Mara's eyes were grey. She walked to the quay."
  },
  {
    kind: 'present',
    who: ['r2 Tomas Harrow (Tomas) · character'],
    fact: 'r2 is on the page in this scene (present, not only named or remembered)',
    text: 'Tomas was already there, coiling rope.'
  }
]

describe('verify.v1 prompt (F-16.17)', () => {
  it('matches the golden messages for a typical batch', () => {
    const built = buildVerifyPrompt({ items })
    expect(built.version).toBe(VERIFY_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content.startsWith(VERIFY_SENTINEL)).toBe(true)
    expect(built.messages[0]?.content).toBe(VERIFY_RULES)
    // Two facts at 28 tokens, a card and an on-page item at 12: the verdicts fit (2026-10-12 review).
    expect(built.maxTokens).toBe(20 + 28 * 2 + 12 * 2)
  })

  it('a strong spot check is one claim at 40 tokens out', () => {
    const spot = buildVerifyPrompt({ items, strong: true })
    expect(spot.messages).toMatchSnapshot()
    expect(spot.maxTokens).toBe(40)
    expect(spot.messages[1]?.content).not.toContain('2. Who:')
  })

  it('caps max_tokens at the budget and splits a batch over 2,500 tokens of items, in order', () => {
    expect(verifyMaxTokens([{ kind: 'claim' }])).toBe(48)
    expect(verifyMaxTokens([{ kind: 'present' }])).toBe(32)
    expect(verifyMaxTokens(Array.from({ length: 100 }, () => ({ kind: 'claim' as const })))).toBe(
      outputBudget('verify')
    )
    const long: VerifyPromptItem[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'claim',
      who: [`r${i} Someone Number ${i} · character`],
      fact: `traits: brave number ${i} (narration, now)`,
      text: 'She walked out into the rain and did not look back at the house. '.repeat(3)
    }))
    const batches = verifyBatches(long)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(long)
    for (const batch of batches) {
      const built = buildVerifyPrompt({ items: batch })
      expect(estimateTokens(built.messages[1]?.content ?? '')).toBeLessThanOrEqual(
        VERIFY_BATCH_TOKENS + 40
      )
      const total = estimateTokens(built.messages.map((m) => m.content).join('\n'))
      expect(total).toBeLessThanOrEqual(inputBudget('verify'))
    }
  })

  it('splits short items so every batch’s verdicts fit its output budget', () => {
    const short: VerifyPromptItem[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'claim',
      who: [`r${i} Mara · character`],
      fact: 'eyes: grey (narration, now)',
      text: 'Her eyes were grey.'
    }))
    const batches = verifyBatches(short)
    expect(batches.flat()).toEqual(short)
    for (const batch of batches) {
      // Every verdict has room: 20 + 28 per fact within the 400.
      expect(20 + 28 * batch.length).toBeLessThanOrEqual(outputBudget('verify'))
      expect(buildVerifyPrompt({ items: batch }).maxTokens).toBe(20 + 28 * batch.length)
    }
    expect(batches[0]).toHaveLength(13)
  })
})
