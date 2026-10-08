import { describe, expect, it } from 'vitest'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_TIME_RULES } from './agent.v3'
import { AGENT_ORGANISE_RULES, AGENT_PROMPT_V4_VERSION, buildAgentPromptV4 } from './agent.v4'

describe('agent.v4 prompt (F-9.10 organise)', () => {
  it('adds the organise rule to every run, after the story-time rule', () => {
    const built = buildAgentPromptV4({
      access: 'write',
      voice: 'VOICE',
      map: 'MAP',
      focus: 'FOCUS',
      history: [{ role: 'user', content: 'Who is Tomas?' }],
      message: 'Organise everything.',
      steps: [{ call: '{"tool":"tags"}', result: 'Result of tags:\nTone: grim' }],
      final: true
    })
    expect(built.version).toBe(AGENT_PROMPT_V4_VERSION)
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: [
          AGENT_RULES,
          AGENT_TIME_RULES,
          AGENT_ORGANISE_RULES,
          AGENT_EDIT_RULES_V2,
          'MAP',
          'FOCUS'
        ].join('\n\n')
      },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'user', content: 'Organise everything.' },
      { role: 'assistant', content: '{"tool":"tags"}' },
      { role: 'user', content: 'Result of tags:\nTone: grim' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('keeps the rule in a read run, and asks the retry at the larger cap', () => {
    const built = buildAgentPromptV4({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [],
      message: 'Tidy the tags.',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${AGENT_RULES}\n\n${AGENT_TIME_RULES}\n\n${AGENT_ORGANISE_RULES}\n\nNo document is open.`
      },
      { role: 'user', content: 'Tidy the tags.' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
    // The golden text of the rule: a change here is a new version.
    expect(AGENT_ORGANISE_RULES).toMatchSnapshot()
  })
})
