import { describe, expect, it } from 'vitest'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS, AGENT_TOOLS_V6 } from '@shared/agent'
import { AGENT_FINAL_TURN } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_ORGANISE_RULES } from './agent.v4'
import { AGENT_LADDER_RULES, AGENT_RULES_V6, AGENT_STATUS_RULES } from './agent.v6'
import {
  AGENT_BULK_RULES,
  AGENT_CLEAR_EDIT,
  AGENT_EDIT_RULES_V7,
  AGENT_ORGANISE_RULES_V7,
  AGENT_PROMPT_V7_VERSION,
  buildAgentPromptV7
} from './agent.v7'

describe('agent.v7 prompt (F-5.25 bulk clear and routing)', () => {
  it('keeps version 6’s rules and tools, and routes a bulk delete to clear, never organise', () => {
    for (const tool of AGENT_TOOLS_V6) expect(AGENT_RULES_V6).toContain(`- ${tool} {`)
    expect(AGENT_BULK_RULES).toContain('delete everything in my story bible')
    expect(AGENT_BULK_RULES).toContain('is a clear, never organising')
    expect(AGENT_BULK_RULES).toContain('{"edit":"clear"}')
    expect(AGENT_BULK_RULES).toContain('Scenes and chapters are never cleared in bulk')
    expect(AGENT_BULK_RULES).toContain('ask what is meant before any edit')
    expect(AGENT_BULK_RULES).toContain('Without the edit list')
    expect(AGENT_ORGANISE_RULES_V7).toContain('never deletes in bulk')
    expect(AGENT_ORGANISE_RULES_V7).not.toBe(AGENT_ORGANISE_RULES)
  })

  it('adds the clear edit to version 2’s list, before its last line', () => {
    expect(AGENT_EDIT_RULES_V7).toBe(
      AGENT_EDIT_RULES_V2.replace(
        'Keep "answer" to a few sentences.',
        `${AGENT_CLEAR_EDIT}Keep "answer" to a few sentences.`
      )
    )
    expect(AGENT_EDIT_RULES_V7).toContain('{"edit":"clear","sheets","tags","library","notes"}')
    expect(AGENT_EDIT_RULES_V7.endsWith('Keep "answer" to a few sentences.')).toBe(true)
  })

  it('orders the system turn: rules, status, ladder, bulk, organise, edit rules, map, focus', () => {
    const built = buildAgentPromptV7({
      access: 'write',
      voice: 'VOICE',
      map: 'MAP',
      focus: 'FOCUS',
      history: [{ role: 'user', content: 'Who is Tomas?' }],
      message: 'Delete everything in my story bible.',
      steps: [
        { call: '{"tool":"list_sheets","args":{"kind":""}}', result: 'Result of list_sheets:\n…' }
      ],
      final: true
    })
    expect(built.version).toBe(AGENT_PROMPT_V7_VERSION)
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: [
          AGENT_RULES_V6,
          AGENT_STATUS_RULES,
          AGENT_LADDER_RULES,
          AGENT_BULK_RULES,
          AGENT_ORGANISE_RULES_V7,
          AGENT_EDIT_RULES_V7,
          'MAP',
          'FOCUS'
        ].join('\n\n')
      },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'user', content: 'Delete everything in my story bible.' },
      { role: 'assistant', content: '{"tool":"list_sheets","args":{"kind":""}}' },
      { role: 'user', content: 'Result of list_sheets:\n…' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('leaves the edit rules out of a read run (Plan), keeping the bulk rule in the shared prefix', () => {
    const built = buildAgentPromptV7({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [],
      message: 'Delete everything in my story bible.',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${AGENT_RULES_V6}\n\n${AGENT_STATUS_RULES}\n\n${AGENT_LADDER_RULES}\n\n${AGENT_BULK_RULES}\n\n${AGENT_ORGANISE_RULES_V7}\n\nNo document is open.`
      },
      { role: 'user', content: 'Delete everything in my story bible.' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
  })
})
