import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import { AGENT_FINAL_TURN, AGENT_RULES, renderAgentFocus } from './agent.v1'
import {
  AGENT_EDIT_RULES_V2,
  AGENT_PROMPT_V2_VERSION,
  AGENT_RETRY_TURN,
  buildAgentPromptV2
} from './agent.v2'

const FOCUS = renderAgentFocus({
  ref: 'n7',
  title: 'Chapter 1 › The ferry landing',
  level: 'scene',
  synopsis: 'Mara confronts Tomas.',
  notes: '',
  summary: '',
  beforeCaret: 'He looked at the lantern.',
  selection: ''
})

describe('agent.v2 prompt (F-5.22, 2026-10-07)', () => {
  it('asks for briefs instead of prose, and keeps every edit kind', () => {
    expect(AGENT_PROMPT_V2_VERSION).toBe('agent.v2')
    expect(AGENT_EDIT_RULES_V2).toContain('Never write manuscript prose yourself')
    expect(AGENT_EDIT_RULES_V2).toContain('{"edit":"insert","id","after","brief","words"}')
    expect(AGENT_EDIT_RULES_V2).toContain('{"edit":"text","id","find","brief"}')
    for (const edit of ['synopsis', 'notes', 'sheet', 'create', 'rename', 'move', 'split']) {
      expect(AGENT_EDIT_RULES_V2).toContain(`{"edit":"${edit}"`)
    }
    // The opening the e2e fake keys on is version 1's, unchanged.
    expect(AGENT_RULES.startsWith('You are the assistant inside a novel-writing app')).toBe(true)
  })

  it('orders rules, edit rules, and the open document (no voice block), then history, the message, the steps, and the final turn', () => {
    const built = buildAgentPromptV2({
      access: 'write',
      voice: 'VOICE',
      focus: FOCUS,
      history: [
        { role: 'user', content: 'Who is Tomas?' },
        { role: 'assistant', content: 'The man the mill owes.' }
      ],
      message: 'Add a beat.',
      steps: [{ call: '{"tool":"tags"}', result: 'Result of tags:\nTone: grim' }],
      final: true
    })
    expect(built.version).toBe('agent.v2')
    expect(built.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
    expect(built.messages).toEqual([
      { role: 'system', content: `${AGENT_RULES}\n\n${AGENT_EDIT_RULES_V2}\n\n${FOCUS}` },
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'assistant', content: 'The man the mill owes.' },
      { role: 'user', content: 'Add a beat.' },
      { role: 'assistant', content: '{"tool":"tags"}' },
      { role: 'user', content: 'Result of tags:\nTone: grim' },
      { role: 'user', content: AGENT_FINAL_TURN }
    ])
  })

  it('asks the one retry for a short reply at the larger cap, within the feature budget', () => {
    const built = buildAgentPromptV2({
      access: 'read',
      voice: null,
      focus: null,
      history: [],
      message: 'Who owes the mill?',
      steps: [],
      final: false,
      retry: true
    })
    expect(built.messages).toEqual([
      { role: 'system', content: `${AGENT_RULES}\n\nNo document is open.` },
      { role: 'user', content: 'Who owes the mill?' },
      { role: 'user', content: AGENT_RETRY_TURN }
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
    expect(AGENT_RETRY_MAX_TOKENS).toBe(outputBudget('agent'))
    // The golden estimate of the rules: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(`${AGENT_RULES}\n\n${AGENT_EDIT_RULES_V2}`)).toBe(GOLDEN_RULES_TOKENS)
  })
})

/** The estimate of the full rules (read rules plus edit rules) when agent.v2 shipped. */
const GOLDEN_RULES_TOKENS = 742
