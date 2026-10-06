import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { ROUTE_ACTIONS } from '@shared/assistantRoute'
import { buildRoutePrompt, ROUTE_PROMPT_VERSION, ROUTE_RULES } from './route.v1'

describe('route.v1 prompt (F-5.19)', () => {
  it('lists every action in the stable system turn and asks for JSON only', () => {
    expect(ROUTE_PROMPT_VERSION).toBe('route.v1')
    for (const action of ROUTE_ACTIONS) expect(ROUTE_RULES).toContain(`- ${action}: `)
    expect(ROUTE_RULES).toContain('Reply with JSON only: {"action":"chat","instruction":""}.')
    expect(
      ROUTE_RULES.startsWith("You are the router inside a novel-writing app's assistant.")
    ).toBe(true)
  })

  it('puts the turns, the open document, the selection, and the message in the user turn', () => {
    const built = buildRoutePrompt({
      message: 'Make this colder.',
      history: [
        { role: 'user', content: 'Who is Tomas?' },
        { role: 'assistant', content: 'The man the mill owes.' }
      ],
      active: 'scene "The ferry landing"',
      selection: 'He looked at the lantern.'
    })
    expect(built.version).toBe('route.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: ROUTE_RULES },
      {
        role: 'user',
        content:
          'Recent turns:\nAuthor: Who is Tomas?\nAssistant: The man the mill owes.\n\n' +
          'Open document: scene "The ferry landing"\n\n' +
          'Selected passage (opening):\n"""\nHe looked at the lantern.\n"""\n\n' +
          'Message:\n"""\nMake this colder.\n"""'
      }
    ])
    expect(built.maxTokens).toBe(outputBudget('route'))
    expect('temperature' in built).toBe(false)
  })

  it('says so when nothing is open or selected, and costs what the golden estimate says', () => {
    const built = buildRoutePrompt({
      message: 'Who owes the mill?',
      history: [],
      active: null,
      selection: null
    })
    expect(built.messages[1]?.content).toBe(
      'No document is open.\n\nNo passage is selected.\n\nMessage:\n"""\nWho owes the mill?\n"""'
    )
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(296)
  })
})
