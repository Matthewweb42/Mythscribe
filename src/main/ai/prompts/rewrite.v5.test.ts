import { describe, expect, it } from 'vitest'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { renderSceneMood } from '@shared/sceneCard'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildRewritePromptV4 } from './rewrite.v4'
import { buildRewritePromptV5, type BuildRewritePromptV5Input } from './rewrite.v5'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'
const MOOD = renderSceneMood('quiet dread', 'debts come due') ?? ''

const input: BuildRewritePromptV5Input = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara Vell', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  storyNotes: FIXTURE_STORY_NOTES,
  mood: MOOD
}

describe('rewrite.v5 prompt (F-16.14)', () => {
  it('matches the golden messages: the Story notes in the system turn, the mood first in the user turn, no steer', () => {
    const built = buildRewritePromptV5(input)
    expect(built.version).toBe('rewrite.v5')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toContain(`${STORY_NOTES_HEADING}`)
    expect(built.messages[1]?.content.startsWith(`${MOOD}\n\nText before:`)).toBe(true)
    const all = built.messages.map((m) => m.content).join('\n')
    expect(all).not.toContain(SCENE_STEER_HEADING)
    expect(all).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(all).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("is version 4's messages with the notes in the bible's slot and no steer", () => {
    const { storyNotes, ...rest } = input
    const v4 = buildRewritePromptV4({ ...rest, bible: storyNotes, steer: null })
    expect(buildRewritePromptV5(input)).toEqual({ ...v4, version: 'rewrite.v5' })
  })
})
