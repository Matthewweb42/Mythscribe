import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { WHAT_NEXT_RULES } from './whatNext.v1'
import { buildWhatNextPromptV3, WHAT_NEXT_TIME_RULE } from './whatNext.v3'
import {
  buildWhatNextPromptV4,
  WHAT_NEXT_RULES_V4,
  WHAT_NEXT_TIME_RULE_V4,
  type BuildWhatNextPromptV4Input
} from './whatNext.v4'

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

  it("is version 3's messages with the notes in the bible's slot, no steer, and its words for them", () => {
    const { storyNotes, ...rest } = input
    const v3 = buildWhatNextPromptV3({ ...rest, bible: storyNotes, steer: null })
    const v4 = buildWhatNextPromptV4(input)
    expect(v4.maxTokens).toBe(v3.maxTokens)
    expect(v4.messages[1]).toEqual(v3.messages[1])
    expect(v4.messages[0]?.content).toBe(
      v3.messages[0]?.content
        .replace(WHAT_NEXT_RULES, WHAT_NEXT_RULES_V4)
        .replace(WHAT_NEXT_TIME_RULE, WHAT_NEXT_TIME_RULE_V4)
    )
    // Every rule names the block as it is headed, and the time rule keeps notes timeless.
    expect(v4.messages[0]?.content).not.toMatch(/\bbible\b/u)
    expect(WHAT_NEXT_RULES_V4).not.toBe(WHAT_NEXT_RULES)
    expect(WHAT_NEXT_TIME_RULE_V4).toContain('never make a plot event happen')
  })
})
