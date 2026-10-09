import { describe, expect, it } from 'vitest'
import {
  AGENT_RETRY_MAX_TOKENS,
  AGENT_STEP_MAX_TOKENS,
  AGENT_TOOLS_V1,
  AGENT_TOOLS_V6
} from '@shared/agent'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_ORGANISE_RULES } from './agent.v4'
import {
  AGENT_LADDER_RULES,
  AGENT_PROMPT_V6_VERSION,
  AGENT_RULES_V6,
  AGENT_STATUS_RULES,
  buildAgentPromptV6
} from './agent.v6'

describe('agent.v6 prompt (F-5.24 lookup ladder)', () => {
  it('opens with version 1’s sentence and names every v6 tool, and no dropped one', () => {
    expect(AGENT_RULES_V6.slice(0, 80)).toBe(AGENT_RULES.slice(0, 80))
    for (const tool of AGENT_TOOLS_V6) expect(AGENT_RULES_V6).toContain(`- ${tool} {`)
    for (const tool of AGENT_TOOLS_V1.filter(
      (t) => !(AGENT_TOOLS_V6 as readonly string[]).includes(t)
    )) {
      expect(AGENT_RULES_V6).not.toContain(`- ${tool} {`)
    }
    expect(AGENT_TOOLS_V6).not.toContain('search')
    expect(AGENT_TOOLS_V6).not.toContain('read_summary')
  })

  it('states the ladder and the status labels', () => {
    expect(AGENT_LADDER_RULES).toContain('→ lookup')
    expect(AGENT_LADDER_RULES).toContain('→ cards')
    expect(AGENT_LADDER_RULES).toContain('→ find_passages')
    expect(AGENT_LADDER_RULES).toContain('read_scene last')
    expect(AGENT_LADDER_RULES).toContain('never resolve one or fill a gap with your own idea')
    for (const mark of ['[canon]', '[plan]', '[idea]']) {
      expect(AGENT_STATUS_RULES).toContain(mark)
    }
    expect(AGENT_STATUS_RULES).toContain('▶ NOW')
  })

  it('orders the system turn: rules, status, ladder, organise, edit rules, map, focus', () => {
    const built = buildAgentPromptV6({
      access: 'write',
      voice: 'VOICE',
      map: 'MAP',
      focus: 'FOCUS',
      history: [{ role: 'user', content: 'Who is Tomas?' }],
      message: 'How old is Mara?',
      steps: [
        { call: '{"tool":"lookup","args":{"name":"Mara"}}', result: 'Result of lookup:\nMara' }
      ],
      final: true
    })
    expect(built.version).toBe(AGENT_PROMPT_V6_VERSION)
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: [
          AGENT_RULES_V6,
          AGENT_STATUS_RULES,
          AGENT_LADDER_RULES,
          AGENT_ORGANISE_RULES,
          AGENT_EDIT_RULES_V2,
          'MAP',
          'FOCUS'
        ].join('\n\n')
      },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'user', content: 'How old is Mara?' },
      { role: 'assistant', content: '{"tool":"lookup","args":{"name":"Mara"}}' },
      { role: 'user', content: 'Result of lookup:\nMara' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('leaves the edit rules out of a read run, and asks the retry at the larger cap', () => {
    const built = buildAgentPromptV6({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [],
      message: 'Who is Mara?',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${AGENT_RULES_V6}\n\n${AGENT_STATUS_RULES}\n\n${AGENT_LADDER_RULES}\n\n${AGENT_ORGANISE_RULES}\n\nNo document is open.`
      },
      { role: 'user', content: 'Who is Mara?' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
  })
})
