import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { FIXTURE_STORY_NOTES_NO_MOOD } from '../eval/storyNotesFixture'
import type { BuildRewritePromptV5Input } from './rewrite.v5'
import { buildRewriteRegenPromptV4 } from './rewriteRegen.v4'
import { buildRewriteRegenPromptV5 } from './rewriteRegen.v5'

const input: BuildRewritePromptV5Input = {
  text: 'Mara counted the lightning gaps, each one shorter than the last.',
  before: '',
  after: 'The ferry would not wait.',
  meta: { location: '', pov: 'Mara Vell', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: null,
  storyNotes: FIXTURE_STORY_NOTES_NO_MOOD,
  mood: null
}

describe('rewriteRegen.v5 prompt (F-16.14)', () => {
  it('carries version 4’s note and violation clauses over rewrite.v5’s messages', () => {
    const built = buildRewriteRegenPromptV5({
      ...input,
      note: 'Less ornate.',
      violation: 'switches to present tense'
    })
    expect(built.version).toBe('rewriteRegen.v5')
    expect(built.messages).toMatchSnapshot()
    const { storyNotes, ...rest } = input
    expect(built.messages).toEqual(
      buildRewriteRegenPromptV4({
        ...rest,
        bible: storyNotes,
        steer: null,
        note: 'Less ornate.',
        violation: 'switches to present tense'
      }).messages
    )
  })
})
