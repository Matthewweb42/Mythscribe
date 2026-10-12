import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { builtinParams } from '@shared/presets'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET } from '@shared/storyBible'
import {
  FIXTURE_GHOST_STORY_NOTES,
  MAXED_GHOST_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildGhostTextPromptV4 } from './ghostText.v4'
import {
  buildGhostTextPromptV5,
  GHOST_PROMPT_V5_VERSION,
  type BuildGhostTextPromptV5Input
} from './ghostText.v5'

const input: BuildGhostTextPromptV5Input = {
  before:
    'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
    'lightning gaps.',
  after: 'The ferry would not wait.',
  notes: 'Mara reaches the ferry.',
  meta: { location: 'Ferry landing', pov: 'Mara Vell', timeline: 'dusk' },
  brief: null,
  voice: "Match the author's voice:\n- Narration is in past tense.",
  storyNotes: FIXTURE_GHOST_STORY_NOTES,
  preset: builtinParams('general')
}

describe('ghostText.v5 prompt (F-16.14)', () => {
  it('matches the golden messages: the Story notes block last in the system prefix, no steer', () => {
    const built = buildGhostTextPromptV5(input)
    expect(built.version).toBe(GHOST_PROMPT_V5_VERSION)
    expect(built.messages).toMatchSnapshot()
    const system = built.messages[0]?.content ?? ''
    expect(system.endsWith(`\n\n${FIXTURE_GHOST_STORY_NOTES}`)).toBe(true)
    expect(system).toContain(STORY_NOTES_HEADING)
    expect(built.messages[1]?.content).not.toContain(SCENE_STEER_HEADING)
  })

  it("is version 4's messages with the notes in the bible's slot and no steer", () => {
    const { storyNotes, ...rest } = input
    const v4 = buildGhostTextPromptV4({ ...rest, bible: storyNotes, steer: null })
    const built = buildGhostTextPromptV5(input)
    expect(built.messages).toEqual(v4.messages)
    expect(built.maxTokens).toBe(v4.maxTokens)
    expect(built.temperature).toBe(v4.temperature)
  })

  it('never carries Ideas or Not canon text, and the block keeps the ghost budget', () => {
    for (const notes of [FIXTURE_GHOST_STORY_NOTES, MAXED_GHOST_STORY_NOTES]) {
      const text = buildGhostTextPromptV5({ ...input, storyNotes: notes })
        .messages.map((m) => m.content)
        .join('\n')
      expect(text).not.toContain(STORY_NOTES_IDEA_TEXT)
      expect(text).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
      expect(estimateTokens(notes)).toBeLessThanOrEqual(STORY_BIBLE_GHOST_TOKEN_BUDGET)
      expect(estimateTokens(text)).toBeLessThan(inputBudget('ghostText'))
    }
  })
})
