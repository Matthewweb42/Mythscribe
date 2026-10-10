import { describe, expect, it } from 'vitest'
import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { BuildAgentPromptV3Input } from './agent.v3'
import { AGENT_EDIT_RULES_V7, buildAgentPromptV7 } from './agent.v7'
import {
  AGENT_EDITS_V8,
  AGENT_EDIT_RULES_V8,
  AGENT_PROMPT_V8_VERSION,
  buildAgentPromptV8
} from './agent.v8'

const input = (access: 'read' | 'write'): BuildAgentPromptV3Input => ({
  access,
  voice: null,
  map: 'Story map:\n▶ NOW n3 Scene 1',
  focus: 'Open document: n3 Scene 1',
  history: [{ role: 'user', content: 'Earlier.' }],
  message: 'Mark Mara’s age an idea.',
  steps: [{ call: '{"tool":"todo","args":{}}', result: 'Result of todo:\nt1 [Gap] Mara: why' }],
  final: false
})

describe('agent.v8 prompt (F-5.25 fixes 5, 7, 8)', () => {
  it('sends version 7’s rules unchanged on a read run (Plan)', () => {
    const v8 = buildAgentPromptV8(input('read'))
    const v7 = buildAgentPromptV7(input('read'))
    expect(v8.version).toBe(AGENT_PROMPT_V8_VERSION)
    expect(v8.messages).toEqual(v7.messages)
    expect(v8.maxTokens).toBe(AGENT_STEP_MAX_TOKENS)
  })

  it('changes only the write run’s edit list: notes clearing, then the v8 edits before the last line', () => {
    expect(AGENT_EDIT_RULES_V8).toBe(
      AGENT_EDIT_RULES_V7.replace(
        'points added to the notes, one per line.\n',
        'points added to the notes, one per line; "text":"" clears them.\n'
      ).replace(
        'Keep "answer" to a few sentences.',
        `${AGENT_EDITS_V8}Keep "answer" to a few sentences.`
      )
    )
    expect(AGENT_EDIT_RULES_V8).toContain('"text":"" clears them')
    for (const edit of ['status', 'todo', 'undo', 'summaries', 'open']) {
      expect(AGENT_EDITS_V8).toContain(`{"edit":"${edit}"`)
    }
    expect(AGENT_EDITS_V8).toContain('canon, plan, or idea')
    expect(AGENT_EDITS_V8).toContain('"done":false dismisses')
    expect(AGENT_EDITS_V8).toContain('"upload" or "library"')
    const write = buildAgentPromptV8(input('write')).messages[0]?.content ?? ''
    const v7 = buildAgentPromptV7(input('write')).messages[0]?.content ?? ''
    expect(write).toBe(v7.replace(AGENT_EDIT_RULES_V7, AGENT_EDIT_RULES_V8))
  })

  it('keeps the stable prefix first and the retry cap', () => {
    const built = buildAgentPromptV8({ ...input('write'), retry: true })
    expect(built.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'user',
      'user'
    ])
    expect(built.maxTokens).toBe(AGENT_RETRY_MAX_TOKENS)
  })
})
