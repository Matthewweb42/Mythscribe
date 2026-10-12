import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildNotesSuggestPromptV2 } from './notesSuggest.v2'
import {
  buildNotesSuggestPromptV3,
  NOTES_SUGGEST_PROMPT_V3_VERSION,
  type BuildNotesSuggestPromptV3Input
} from './notesSuggest.v3'

const input: BuildNotesSuggestPromptV3Input = {
  sceneText: 'Mara set the lantern down. The river was rising.',
  summary: { summary: 'Mara waits for the ferry.', keyPoints: ['The river rises.'] },
  brief: null,
  notes: 'Tomas is late.',
  storyNotes: FIXTURE_STORY_NOTES,
  instruction: null
}

describe('notesSuggest.v3 prompt (F-16.14, decision P1-D7)', () => {
  it('matches the golden messages: the Story notes after the rules', () => {
    const built = buildNotesSuggestPromptV3(input)
    expect(built.version).toBe(NOTES_SUGGEST_PROMPT_V3_VERSION)
    expect(built.messages).toMatchSnapshot()
    const system = built.messages[0]?.content ?? ''
    expect(system.endsWith(`\n\n${FIXTURE_STORY_NOTES}`)).toBe(true)
    expect(system).toContain(STORY_NOTES_HEADING)
    expect(system).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(system).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("is version 2's messages with the notes in the bible's slot", () => {
    const { storyNotes, ...rest } = input
    const v2 = buildNotesSuggestPromptV2({ ...rest, bible: storyNotes })
    expect(buildNotesSuggestPromptV3(input)).toEqual({
      ...v2,
      version: NOTES_SUGGEST_PROMPT_V3_VERSION
    })
  })
})
