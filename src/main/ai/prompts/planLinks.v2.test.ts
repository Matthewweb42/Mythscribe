import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { CARD_GIST_MAX_WORDS } from '@shared/memory/claims'
import { PLAN_LINKS_TEXT_MAX } from '@shared/planLinks'
import {
  buildPlanLinksPromptV2,
  PLAN_LINKS_PROMPT_V2_VERSION,
  PLAN_LINKS_V2_MAX_TOKENS,
  PLAN_LINKS_V2_RULES,
  PLAN_LINKS_V2_SENTINEL
} from './planLinks.v2'

describe('planLinks.v2 prompt (F-16.21, decision 2)', () => {
  it('sends the plan and the two scenes by title and card, the rules alone in the system turn', () => {
    const built = buildPlanLinksPromptV2({
      plan: { title: 'Mara at the quay', synopsis: 'She waits for the ferry at dusk.' },
      scenes: [
        {
          title: 'The quay',
          line: 'Mara walks to the quay.',
          gist: 'Mara waits; the ferry is late.'
        },
        { title: 'Harbour 1', line: 'Mara walks to the quay.', gist: '' }
      ]
    })
    expect(built.version).toBe(PLAN_LINKS_PROMPT_V2_VERSION)
    expect(built.version).toBe('planLinks.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: PLAN_LINKS_V2_RULES },
      {
        role: 'user',
        content:
          'Planned scene "Mara at the quay": She waits for the ferry at dusk.\n\n' +
          'Drafted scenes:\n' +
          'S1 "The quay": Mara walks to the quay. Gist: Mara waits; the ferry is late.\n' +
          'S2 "Harbour 1": Mara walks to the quay.\n\n' +
          'Pick the scene that fulfils the plan.'
      }
    ])
    expect(built.maxTokens).toBe(PLAN_LINKS_V2_MAX_TOKENS)
    expect(PLAN_LINKS_V2_MAX_TOKENS).toBe(100)
    expect(PLAN_LINKS_V2_RULES).toContain('{"pick":"S1","why":"one short sentence"}')
    expect(PLAN_LINKS_V2_RULES.startsWith(PLAN_LINKS_V2_SENTINEL)).toBe(true)
  })

  it('pins the sentinel the e2e fake answers by', () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/memory.spec.ts'), 'utf8')
    const match = /const PLAN_LINKS_V2_SENTINEL =\s*'([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/memory.spec.ts no longer declares PLAN_LINKS_V2_SENTINEL')
    expect(PLAN_LINKS_V2_SENTINEL.startsWith(match[1]!)).toBe(true)
  })

  it('stays within 1,500 tokens with every part at its cap', () => {
    const gist = Array.from({ length: CARD_GIST_MAX_WORDS }, () => 'considerable').join(' ')
    const scene = { title: 'T'.repeat(80), line: 'l'.repeat(250), gist }
    const built = buildPlanLinksPromptV2({
      plan: { title: 'P'.repeat(80), synopsis: 's'.repeat(PLAN_LINKS_TEXT_MAX) },
      scenes: [scene, scene]
    })
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(
      1_500
    )
  })
})
