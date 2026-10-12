import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { builtinParams } from '@shared/presets'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildChatPromptV5 } from './chat.v5'
import { buildChatPromptV6, CHAT_PROMPT_V6_VERSION, type BuildChatPromptV6Input } from './chat.v6'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'

const plan: BuildChatPromptV6Input = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: SCENE,
  sceneMeta: null,
  brief: null,
  panel: { synopsis: 'Mara crosses before the storm.', notes: '' },
  refs: [],
  history: [],
  message: 'What is missing from this scene?',
  voice: null,
  storyNotes: FIXTURE_STORY_NOTES,
  preset: null
}
const agent: BuildChatPromptV6Input = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  message: 'Bring Tomas onto the landing.',
  voice: "Match the author's voice:\n- Narration is in past tense.",
  preset: builtinParams('general')
}

describe('chat.v6 prompt (F-16.14)', () => {
  it('matches the golden messages in both modes, the Story notes in the bible’s slot', () => {
    for (const input of [plan, agent]) {
      const built = buildChatPromptV6(input)
      expect(built.version).toBe(CHAT_PROMPT_V6_VERSION)
      expect(built.messages).toMatchSnapshot(input.mode)
      const system = built.messages[0]?.content ?? ''
      expect(system).toContain(STORY_NOTES_HEADING)
      expect(system).not.toContain(SCENE_STEER_HEADING)
      expect(system).not.toContain(STORY_NOTES_IDEA_TEXT)
      expect(system).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
    }
  })

  it("is version 5's messages with the notes in the bible's slot and no steer", () => {
    for (const input of [plan, agent, { ...plan, storyNotes: null }]) {
      const { storyNotes, ...rest } = input
      const v5 = buildChatPromptV5({ ...rest, bible: storyNotes, steer: null })
      expect(buildChatPromptV6(input)).toEqual({ ...v5, version: CHAT_PROMPT_V6_VERSION })
    }
  })
})
