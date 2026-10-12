import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { FIXTURE_GHOST_STORY_NOTES } from '../eval/storyNotesFixture'
import { buildGhostTextPromptV5, type BuildGhostTextPromptV5Input } from './ghostText.v5'
import { buildGhostTextRegenPromptV4 } from './ghostTextRegen.v4'
import { buildGhostTextRegenPromptV5, GHOST_REGEN_PROMPT_V5_VERSION } from './ghostTextRegen.v5'

const input: BuildGhostTextPromptV5Input = {
  before: 'Mara pulled her cloak tight and counted the lightning gaps.',
  after: '',
  notes: null,
  meta: null,
  brief: null,
  voice: "Match the author's voice:\n- Narration is in past tense.",
  storyNotes: FIXTURE_GHOST_STORY_NOTES,
  preset: builtinParams('general')
}

describe('ghostTextRegen.v5 prompt (F-16.14)', () => {
  it('appends version 4’s clause to ghostText.v5’s system turn, the user turn unchanged', () => {
    const built = buildGhostTextRegenPromptV5({ ...input, violation: 'switches to present tense' })
    const base = buildGhostTextPromptV5(input)
    expect(built.version).toBe(GHOST_REGEN_PROMPT_V5_VERSION)
    expect(built.messages[1]).toEqual(base.messages[1])
    expect(built.messages[0]?.content.startsWith(base.messages[0]?.content ?? '')).toBe(true)
    expect(built.messages).toMatchSnapshot()
    const { storyNotes, ...rest } = input
    expect(built.messages).toEqual(
      buildGhostTextRegenPromptV4({
        ...rest,
        bible: storyNotes,
        steer: null,
        violation: 'switches to present tense'
      }).messages
    )
  })
})
