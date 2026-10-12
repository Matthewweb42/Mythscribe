import { describe, expect, it } from 'vitest'
import { FIXTURE_STORY_NOTES } from '../eval/storyNotesFixture'
import type { BuildCritiquePromptV4Input } from './critique.v4'
import { buildCritiqueRegenPromptV3 } from './critiqueRegen.v3'
import { buildCritiqueRegenPromptV4 } from './critiqueRegen.v4'

const input: BuildCritiquePromptV4Input = {
  sceneText: 'Mara pulled her cloak tight and counted the lightning gaps.',
  brief: null,
  meta: null,
  voice: null,
  storyNotes: FIXTURE_STORY_NOTES,
  honesty: 'brutal'
}

describe('critiqueRegen.v4 prompt (F-16.14)', () => {
  it('carries version 3’s note clause over critique.v4’s messages', () => {
    const built = buildCritiqueRegenPromptV4({ ...input, note: 'Focus on pacing.' })
    expect(built.version).toBe('critiqueRegen.v4')
    expect(built.messages).toMatchSnapshot()
    const { storyNotes, ...rest } = input
    expect(built.messages).toEqual(
      buildCritiqueRegenPromptV3({ ...rest, bible: storyNotes, note: 'Focus on pacing.' }).messages
    )
  })
})
