import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { FIXTURE_STORY_NOTES } from '../eval/storyNotesFixture'
import type { BuildChatPromptV6Input } from './chat.v6'
import { buildChatRegenPromptV5 } from './chatRegen.v5'
import { buildChatRegenPromptV6, CHAT_REGEN_PROMPT_V6_VERSION } from './chatRegen.v6'

const agent: BuildChatPromptV6Input = {
  mode: 'agent',
  paragraphs: 2,
  sceneText: 'Mara pulled her cloak tight and counted the lightning gaps.',
  sceneMeta: null,
  brief: null,
  panel: null,
  refs: [],
  history: [],
  message: 'Bring Tomas onto the landing.',
  voice: "Match the author's voice:\n- Narration is in past tense.",
  storyNotes: FIXTURE_STORY_NOTES,
  preset: builtinParams('general')
}

describe('chatRegen.v6 prompt (F-16.14)', () => {
  it('appends version 5’s clause over chat.v6’s messages', () => {
    const built = buildChatRegenPromptV6({ ...agent, violation: 'switches to present tense' })
    expect(built.version).toBe(CHAT_REGEN_PROMPT_V6_VERSION)
    expect(built.messages).toMatchSnapshot()
    const { storyNotes, ...rest } = agent
    expect(built.messages).toEqual(
      buildChatRegenPromptV5({
        ...rest,
        bible: storyNotes,
        steer: null,
        violation: 'switches to present tense'
      }).messages
    )
  })
})
