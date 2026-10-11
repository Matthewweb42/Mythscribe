import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { ROUTE_ACTIONS, ROUTE_EDIT_PASSES, ROUTE_EDIT_TARGETS } from '@shared/assistantRoute'
import { buildRoutePrompt, ROUTE_RULES } from './route.v1'
import { buildRoutePromptV2, ROUTE_PROMPT_V2_VERSION, ROUTE_RULES_V2 } from './route.v2'

describe('route.v2 prompt (F-5.26)', () => {
  it('lists every action but proofread, which is now the proofread pass, and asks for JSON only', () => {
    expect(ROUTE_PROMPT_V2_VERSION).toBe('route.v2')
    for (const action of ROUTE_ACTIONS) {
      if (action === 'proofread') expect(ROUTE_RULES_V2).not.toContain(`- ${action}: `)
      else expect(ROUTE_RULES_V2).toContain(`- ${action}: `)
    }
    expect(ROUTE_RULES_V2).toContain('Reply with JSON only: {"action":"chat","instruction":""}.')
    expect(ROUTE_RULES_V2).toContain(
      '{"action":"editPass","instruction":"","pass":"ask","target":"scene","chapter":""}'
    )
    // The same opening as v1, so a fake provider keys on either version.
    expect(ROUTE_RULES_V2.slice(0, 60)).toBe(ROUTE_RULES.slice(0, 60))
  })

  it('names every pass and every target an edit pass can take', () => {
    for (const pass of ROUTE_EDIT_PASSES) expect(ROUTE_RULES_V2).toContain(`"${pass}"`)
    for (const target of ROUTE_EDIT_TARGETS) expect(ROUTE_RULES_V2).toContain(`"${target}"`)
  })

  it("sends v1's user turn under the new rules", () => {
    const input = {
      message: 'Make this scene better.',
      history: [{ role: 'user' as const, content: 'Who is Tomas?' }],
      active: 'scene "The ferry landing"',
      selection: null
    }
    const built = buildRoutePromptV2(input)
    expect(built.version).toBe('route.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: ROUTE_RULES_V2 },
      {
        role: 'user',
        content:
          'Recent turns:\nAuthor: Who is Tomas?\n\n' +
          'Open document: scene "The ferry landing"\n\n' +
          'No passage is selected.\n\n' +
          'Message:\n"""\nMake this scene better.\n"""'
      }
    ])
    expect(built.messages[1]).toEqual(buildRoutePrompt(input).messages[1])
    expect(built.maxTokens).toBe(outputBudget('route'))
  })

  it('costs what the golden estimate says', () => {
    const built = buildRoutePromptV2({
      message: 'Who owes the mill?',
      history: [],
      active: null,
      selection: null
    })
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(497)
  })
})
