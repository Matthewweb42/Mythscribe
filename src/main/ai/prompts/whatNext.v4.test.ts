import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildWhatNextPromptV3 } from './whatNext.v3'
import { buildWhatNextPromptV4, type BuildWhatNextPromptV4Input } from './whatNext.v4'

const input: BuildWhatNextPromptV4Input = {
  text: 'Mara set the lantern down. The river was rising.',
  brief: 'Goal: Mara reaches the ferry.',
  storyNotes: FIXTURE_STORY_NOTES,
  map: 'Story map:\n▶ NOW Ch 1 · The ferry landing (drafted)'
}

describe('whatNext.v4 prompt (F-16.14)', () => {
  it('matches the golden messages: the Story notes before the map, no steer', () => {
    const built = buildWhatNextPromptV4(input)
    expect(built.version).toBe('whatNext.v4')
    expect(built.messages).toMatchSnapshot()
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(STORY_NOTES_HEADING)).toBeLessThan(system.indexOf('Story map:'))
    const all = built.messages.map((m) => m.content).join('\n')
    expect(all).not.toContain(SCENE_STEER_HEADING)
    expect(all).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(all).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("is version 3's messages with the notes in the bible's slot and no steer", () => {
    const { storyNotes, ...rest } = input
    const v3 = buildWhatNextPromptV3({ ...rest, bible: storyNotes, steer: null })
    expect(buildWhatNextPromptV4(input)).toEqual({ ...v3, version: 'whatNext.v4' })
  })
})
