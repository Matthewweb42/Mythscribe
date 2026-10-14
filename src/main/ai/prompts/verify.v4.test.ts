import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import {
  VERIFY_SENTINEL,
  buildVerifyV2Prompt,
  verifyV2Batches,
  type VerifyV2Item
} from './verify.v2'
import { VERIFY_V3_RULES } from './verify.v3'
import { VERIFY_V4_PROMPT_VERSION, VERIFY_V4_RULES, buildVerifyV4Prompt } from './verify.v4'

const KNOWS: VerifyV2Item = {
  kind: 'knows',
  who: ['r3 Orrin · character'],
  from: ['r4 Tomas · character'],
  topic: 's1 the sold map: “Tomas sold the map on the quay”',
  fact: 'knows, overheard from r4 (narration, now)',
  text: 'Tomas sold the map on the quay. Orrin overheard Tomas from behind the nets.'
}

// The third live run's open-ended facts (2026-10-14, 21:35), as the strong batch sends them.
const items: VerifyV2Item[] = [
  {
    kind: 'claim',
    who: ['r1 Clara Pell (Miss Pell) · character', 'r2 Ned Ashby (Mr. Ashby) · character'],
    fact: 'history: asked Miss Pell (dialogue by r3, now)',
    text: 'First of all, he asked Miss Pell. I was so vexed to see him stand up with her.'
  },
  {
    kind: 'claim',
    who: ['r4 Lottie Harrow (Lottie) · character'],
    fact: 'traits: all smiles (narration, now)',
    text: 'At dinner Lottie was all smiles, and Bel would not meet anybody’s eye.'
  },
  KNOWS
]

describe('verify.v4 prompt (F-16.17, the third live run of 2026-10-14)', () => {
  it('matches the golden messages: verify.v2’s items and caps under the v4 rules', () => {
    const built = buildVerifyV4Prompt({ items })
    expect(built.version).toBe(VERIFY_V4_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(VERIFY_V4_RULES)
    const v2 = buildVerifyV2Prompt({ items })
    expect(built.messages[1]).toEqual(v2.messages[1])
    expect(built.maxTokens).toBe(v2.maxTokens)
  })

  it('says who did it and what each open-ended slot holds, and keeps the v3 rules', () => {
    expect(VERIFY_V4_RULES.startsWith(VERIFY_SENTINEL)).toBe(true)
    for (const rule of [
      'never the one it is done to ("he asked Miss Pell" is his, not hers)',
      'traits a lasting quality, never one act',
      'never the relative ("his second daughter" is the daughter)',
      'never a list of people or a remark',
      'never a plan, an expectation or a report',
      'is rumour',
      'A place has no eyes, age, clothes, home or location',
      // verify.v3's, kept.
      'when it means several people ("they", "the sisters")',
      '"you" is the one spoken to',
      'a want, hope or plan never supports having or being it now',
      // The e2e's fake provider tells a v2+ checker by this opening.
      '- A knows item: ok only when'
    ]) {
      expect(VERIFY_V4_RULES, rule).toContain(rule)
    }
    // The open-ended rules cost about 170 tokens over v3's.
    expect(estimateTokens(VERIFY_V4_RULES)).toBeLessThanOrEqual(
      estimateTokens(VERIFY_V3_RULES) + 220
    )
  })

  it('keeps every batch within the checker’s input cap', () => {
    const long: VerifyV2Item[] = Array.from({ length: 60 }, (_, i) => ({
      ...KNOWS,
      text: `She walked out into the rain number ${i} and did not look back. `.repeat(4)
    }))
    for (const batch of verifyV2Batches(long)) {
      const built = buildVerifyV4Prompt({ items: batch })
      expect(
        estimateTokens(built.messages.map((message) => message.content).join('\n'))
      ).toBeLessThanOrEqual(inputBudget('verify'))
    }
  })
})
