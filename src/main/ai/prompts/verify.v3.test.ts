import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import { VERIFY_RULES } from './verify.v1'
import {
  VERIFY_SENTINEL,
  VERIFY_V2_RULES,
  buildVerifyV2Prompt,
  verifyV2Batches,
  type VerifyV2Item
} from './verify.v2'
import { VERIFY_V3_PROMPT_VERSION, VERIFY_V3_RULES, buildVerifyV3Prompt } from './verify.v3'

const KNOWS: VerifyV2Item = {
  kind: 'knows',
  who: ['r3 Orrin · character'],
  from: ['r4 Tomas · character'],
  topic: 's1 the sold map: “Tomas sold the map on the quay”',
  fact: 'knows, overheard from r4 (narration, now)',
  text: 'Tomas sold the map on the quay. Orrin overheard Tomas from behind the nets.'
}

const items: VerifyV2Item[] = [
  {
    kind: 'claim',
    who: ['r1 Johanna Harrow (Johanna) · character', 'r2 Liesel Harrow (Lise) · character'],
    fact: 'location: Callow Cross (narration, now)',
    text: 'On the Wednesday the sisters walked to Callow Cross, because Johanna wanted thread and Lise wanted air.'
  },
  {
    kind: 'claim',
    who: ['r1 Johanna Harrow (Johanna) · character'],
    fact: 'objects: thread (narration, now)',
    text: 'On the Wednesday the sisters walked to Callow Cross, because Johanna wanted thread and Lise wanted air.'
  },
  KNOWS
]

describe('verify.v3 prompt (F-16.17, the live run of 2026-10-14)', () => {
  it('matches the golden messages: verify.v2’s items and caps under the v3 rules', () => {
    const built = buildVerifyV3Prompt({ items })
    expect(built.version).toBe(VERIFY_V3_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(VERIFY_V3_RULES)
    const v2 = buildVerifyV2Prompt({ items })
    expect(built.messages[1]).toEqual(v2.messages[1])
    expect(built.maxTokens).toBe(v2.maxTokens)
    expect(buildVerifyV3Prompt({ items, strong: true }).maxTokens).toBe(
      buildVerifyV2Prompt({ items, strong: true }).maxTokens
    )
  })

  it('refuses one person for several, a want for a thing, and a value of the wrong kind', () => {
    expect(VERIFY_V3_RULES.startsWith(VERIFY_SENTINEL)).toBe(true)
    for (const rule of [
      'when it means several people ("they", "the sisters")',
      '"you" is the one spoken to',
      'a want, hope or plan never supports having or being it now',
      'the value to be what the slot holds',
      'A place has no eyes, age, clothes or home',
      // The e2e's fake provider tells a v2+ checker by this opening.
      '- A knows item: ok only when'
    ]) {
      expect(VERIFY_V3_RULES, rule).toContain(rule)
    }
    expect(VERIFY_V2_RULES).toContain('"they"')
    expect(estimateTokens(VERIFY_V3_RULES)).toBeLessThanOrEqual(estimateTokens(VERIFY_RULES) + 380)
  })

  it('keeps every batch within the checker’s input cap', () => {
    const long: VerifyV2Item[] = Array.from({ length: 60 }, (_, i) => ({
      ...KNOWS,
      text: `She walked out into the rain number ${i} and did not look back. `.repeat(4)
    }))
    for (const batch of verifyV2Batches(long)) {
      const built = buildVerifyV3Prompt({ items: batch })
      expect(
        estimateTokens(built.messages.map((message) => message.content).join('\n'))
      ).toBeLessThanOrEqual(inputBudget('verify'))
    }
  })
})
