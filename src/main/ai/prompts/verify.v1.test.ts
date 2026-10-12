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
    expect(built.maxTokens).toBe(20 + 15 * items.length)
  })

  it('a strong spot check is one claim at 40 tokens out', () => {
    const spot = buildVerifyPrompt({ items, strong: true })
    expect(spot.messages).toMatchSnapshot()
    expect(spot.maxTokens).toBe(40)
    expect(spot.messages[1]?.content).not.toContain('2. Who:')
  })

  it('caps max_tokens at the budget and splits a batch over 2,500 tokens of items, in order', () => {
    expect(verifyMaxTokens(1)).toBe(35)
    expect(verifyMaxTokens(100)).toBe(outputBudget('verify'))
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
})
