import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import { PLAN_LINKS_PROMPT_VERSION, PLAN_LINKS_RULES, buildPlanLinksPrompt } from './planLinks.v1'

describe('planLinks.v1 prompt (F-11.1d)', () => {
  it('keeps the sentinel the e2e keys on', () => {
    expect(
      PLAN_LINKS_RULES.startsWith('You are the plan-link feature inside a novel-writing app.')
    ).toBe(true)
  })

  it('sends the rules alone in the system turn and the labelled plans and scenes in the user turn', () => {
    const built = buildPlanLinksPrompt({
      plans: [
        { label: 'P1', kind: 'scene', title: 'Mara finds the ledger', text: 'She digs it up.' },
        { label: 'P2', kind: 'beat', title: 'Catalyst', text: '' }
      ],
      scenes: [{ label: 'S1', title: 'The elm', summary: 'Mara digs under the elm.' }]
    })
    expect(built.version).toBe(PLAN_LINKS_PROMPT_VERSION)
    expect(built.maxTokens).toBe(outputBudget('planLinks'))
    expect(built.messages).toMatchSnapshot()
  })
})
