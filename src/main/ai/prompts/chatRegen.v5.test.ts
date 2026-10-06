import { describe, expect, it } from 'vitest'
import { buildChatPromptV5 } from './chat.v5'
import { buildChatRegenPromptV5, CHAT_REGEN_PROMPT_V5_VERSION } from './chatRegen.v5'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

describe('chatRegen.v5 prompt (F-5.20)', () => {
  it('is chat.v5 with the violation clause appended to the system turn only', () => {
    const input = {
      mode: 'agent' as const,
      paragraphs: 1,
      sceneText: 'Mara waited at the landing.',
      sceneMeta: null,
      brief: null,
      steer: null,
      panel: { synopsis: 'Mara waits.', notes: '' },
      refs: [],
      history: [{ role: 'user' as const, content: 'Go on.' }],
      message: 'Continue.',
      voice: null,
      bible: null,
      preset: null
    }
    const base = buildChatPromptV5(input)
    const regen = buildChatRegenPromptV5({ ...input, violation: 'switches tense' })
    expect(regen.version).toBe(CHAT_REGEN_PROMPT_V5_VERSION)
    expect(regen.version).toBe('chatRegen.v5')
    expect(regen.messages[0]?.content).toBe(
      `${base.messages[0]?.content}\n\n${REGEN_CLAUSE_PREFIX} switches tense. ` +
        "Write a different draft that keeps the manuscript's voice."
    )
    expect(regen.messages.slice(1)).toEqual(base.messages.slice(1))
    expect(regen.maxTokens).toBe(base.maxTokens)
  })
})
