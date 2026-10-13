import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { VERIFY_BATCH_TOKENS, VERIFY_RULES } from './verify.v1'
import {
  VERIFY_KNOWS_TOKENS,
  VERIFY_SENTINEL,
  VERIFY_STRONG_KNOWS_TOKENS,
  VERIFY_V2_PROMPT_VERSION,
  VERIFY_V2_RULES,
  buildVerifyV2Prompt,
  verifyV2Batches,
  verifyV2MaxTokens,
  type VerifyV2Item
} from './verify.v2'

const KNOWS: VerifyV2Item = {
  kind: 'knows',
  who: ['r3 Orrin · character'],
  from: ['r2 Tomas Harrow (Tomas) · character'],
  topic: 's1 the sold map: “Tomas sold the map on the quay”',
  fact: 'knows, overheard from r2 (narration, now)',
  text: 'Tomas sold the map on the quay. Orrin overheard Tomas from behind the nets.'
}

const items: VerifyV2Item[] = [
  {
    kind: 'claim',
    who: ['r1 Mara Vell (Mara) · character'],
    fact: 'location: the quay (narration, now)',
    text: 'Mara walked to the quay. Tomas was already there.'
  },
  KNOWS,
  {
    kind: 'step',
    who: [],
    topic: 't1 the missing heir: “Mara swore to find the heir”',
    fact: 'resolves: Mara finds the heir (narration, now)',
    text: 'Mara found the heir in the boathouse.'
  },
  {
    kind: 'reveals',
    who: [],
    topic: 'x1 the map sale · new secret',
    fact: '',
    text: 'The map had been sold by Tomas.'
  },
  {
    kind: 'same',
    who: [],
    topic:
      'x1 the map sale: “The map had been sold by Tomas” (1.2) | s1 the sold map: “Tomas sold the map on the quay” (1.1)',
    fact: '',
    text: ''
  },
  {
    kind: 'present',
    who: ['r3 Orrin · character'],
    fact: 'r3 is on the page in this scene (present, not only named or remembered)',
    text: 'Orrin overheard Tomas from behind the nets.'
  }
]

describe('verify.v2 prompt (F-16.22, F-16.23)', () => {
  it('matches the golden messages for a batch with knows, step, reveals and same items', () => {
    const built = buildVerifyV2Prompt({ items })
    expect(built.version).toBe(VERIFY_V2_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content.startsWith(VERIFY_SENTINEL)).toBe(true)
    expect(VERIFY_RULES.startsWith(VERIFY_SENTINEL)).toBe(true)
    expect(built.messages[0]?.content).toBe(VERIFY_V2_RULES)
    // A fact, a step and a reveal at 28 (a reveal answers its voice and mode, so a rumoured
    // secret makes none), a knows item at 36, same and on-page at 12.
    expect(built.maxTokens).toBe(20 + 28 * 3 + VERIFY_KNOWS_TOKENS + 12 * 2)
    expect(built.messages[0]?.content).toContain(
      'A reveals item: ok when the sentences reveal that secret or set up that thread; "voice" and "mode"'
    )
    const user = built.messages[1]?.content ?? ''
    expect(user).toContain('2. Who: r3 Orrin · character\nFrom: r2 Tomas Harrow')
    expect(user).toContain('Secret: s1 the sold map')
    expect(user).toContain('3. Thread: t1 the missing heir')
    expect(user).toContain('4. Reveals: x1 the map sale · new secret')
    expect(user).toContain('5. Same: x1 the map sale')
  })

  it('a strong spot check is one item at 40 tokens out, 48 for a knows line', () => {
    const spot = buildVerifyV2Prompt({ items, strong: true })
    expect(spot.messages[1]?.content).not.toContain('2. Who:')
    expect(spot.maxTokens).toBe(40)
    const knows = buildVerifyV2Prompt({ items: [KNOWS], strong: true })
    expect(knows.messages).toMatchSnapshot()
    expect(knows.maxTokens).toBe(VERIFY_STRONG_KNOWS_TOKENS)
  })

  it('keeps the rules short, and never asks about who does not know', () => {
    expect(estimateTokens(VERIFY_V2_RULES)).toBeLessThanOrEqual(estimateTokens(VERIFY_RULES) + 200)
    expect(text(buildVerifyV2Prompt({ items }).messages)).not.toMatch(
      /No scene shows|checked up to/
    )
  })

  it('caps max_tokens at the budget and splits by input and by output, in order', () => {
    expect(verifyV2MaxTokens([{ kind: 'knows' }])).toBe(20 + 36)
    expect(verifyV2MaxTokens([{ kind: 'same' }])).toBe(32)
    expect(verifyV2MaxTokens([{ kind: 'reveals' }])).toBe(48)
    expect(verifyV2MaxTokens(Array.from({ length: 100 }, () => ({ kind: 'knows' as const })))).toBe(
      outputBudget('verify')
    )
    const knowsMany = Array.from({ length: 30 }, () => KNOWS)
    const batches = verifyV2Batches(knowsMany)
    expect(batches.flat()).toEqual(knowsMany)
    for (const batch of batches) {
      expect(20 + VERIFY_KNOWS_TOKENS * batch.length).toBeLessThanOrEqual(outputBudget('verify'))
    }
    expect(batches[0]).toHaveLength(10)
    const long: VerifyV2Item[] = Array.from({ length: 60 }, (_, i) => ({
      ...KNOWS,
      text: `She walked out into the rain number ${i} and did not look back. `.repeat(4)
    }))
    for (const batch of verifyV2Batches(long)) {
      const built = buildVerifyV2Prompt({ items: batch })
      expect(estimateTokens(built.messages[1]?.content ?? '')).toBeLessThanOrEqual(
        VERIFY_BATCH_TOKENS + 60
      )
      expect(estimateTokens(text(built.messages))).toBeLessThanOrEqual(inputBudget('verify'))
    }
  })
})

function text(messages: { content: string }[]): string {
  return messages.map((m) => m.content).join('\n')
}
