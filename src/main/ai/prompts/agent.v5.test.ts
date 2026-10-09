import { describe, expect, it } from 'vitest'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS, AGENT_TOOLS_V5 } from '@shared/agent'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_TIME_RULES } from './agent.v3'
import { AGENT_ORGANISE_RULES } from './agent.v4'
import { AGENT_PROMPT_V5_VERSION, AGENT_TODO_RULES, buildAgentPromptV5 } from './agent.v5'

describe('agent.v5 prompt (F-9.16 To do list)', () => {
  it('names every tool between the shared rules and the To do paragraph', () => {
    for (const tool of AGENT_TOOLS_V5) {
      expect(`${AGENT_RULES}\n${AGENT_TODO_RULES}`).toContain(`- ${tool} {`)
    }
    expect(AGENT_TODO_RULES).toContain('never resolve one or fill a gap with your own idea')
  })

  it('adds the To do rule to every run, after the organise rule', () => {
    const built = buildAgentPromptV5({
      access: 'write',
      voice: 'VOICE',
      map: 'MAP',
      focus: 'FOCUS',
      history: [{ role: 'user', content: 'Who is Tomas?' }],
      message: "What's left to figure out?",
      steps: [{ call: '{"tool":"todo","args":{}}', result: 'Result of todo:\n[Gap] Mara' }],
      final: true
    })
    expect(built.version).toBe(AGENT_PROMPT_V5_VERSION)
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: [
          AGENT_RULES,
          AGENT_TIME_RULES,
          AGENT_ORGANISE_RULES,
          AGENT_TODO_RULES,
          AGENT_EDIT_RULES_V2,
          'MAP',
          'FOCUS'
        ].join('\n\n')
      },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'user', content: "What's left to figure out?" },
      { role: 'assistant', content: '{"tool":"todo","args":{}}' },
      { role: 'user', content: 'Result of todo:\n[Gap] Mara' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('keeps the rule in a read run, and asks the retry at the larger cap', () => {
    const built = buildAgentPromptV5({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [],
      message: 'Any loose ends?',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${AGENT_RULES}\n\n${AGENT_TIME_RULES}\n\n${AGENT_ORGANISE_RULES}\n\n${AGENT_TODO_RULES}\n\nNo document is open.`
      },
      { role: 'user', content: 'Any loose ends?' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
  })
})
