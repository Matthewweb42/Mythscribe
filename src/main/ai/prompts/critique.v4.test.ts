import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildCritiquePromptV3 } from './critique.v3'
import { buildCritiquePromptV4, type BuildCritiquePromptV4Input } from './critique.v4'

const input: BuildCritiquePromptV4Input = {
  sceneText: 'Mara pulled her cloak tight and counted the lightning gaps.',
  brief: 'Scene brief:\n- Goal: Mara reaches the ferry.',
  meta: { location: 'Ferry landing', pov: 'Mara Vell', timeline: 'dusk', brief: EMPTY_SCENE_BRIEF },
  voice: null,
  storyNotes: FIXTURE_STORY_NOTES,
  honesty: 'direct'
}

describe('critique.v4 prompt (F-16.14)', () => {
  it('matches the golden messages: the Story notes before the scene line in the system turn', () => {
    const built = buildCritiquePromptV4(input)
    expect(built.version).toBe('critique.v4')
    expect(built.messages).toMatchSnapshot()
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(STORY_NOTES_HEADING)).toBeLessThan(system.indexOf('Scene: location'))
    expect(system).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(system).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("is version 3's messages with the notes in the bible's slot", () => {
    const { storyNotes, ...rest } = input
    const v3 = buildCritiquePromptV3({ ...rest, bible: storyNotes })
    expect(buildCritiquePromptV4(input)).toEqual({ ...v3, version: 'critique.v4' })
  })
})
