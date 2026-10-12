import { describe, expect, it } from 'vitest'
import { EDIT_PASS_TYPES } from '@shared/editPass'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import { renderSceneMood } from '@shared/sceneCard'
import {
  FIXTURE_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { EDIT_PASS_SENTINEL, EDIT_PASS_TASKS } from './editPass.v1'
import { buildEditPassPromptV2 } from './editPass.v2'
import {
  buildEditPassPromptV3,
  EDIT_PASS_PROMPT_V3_VERSION,
  EDIT_PASS_V3_CONTINUITY_TASK,
  type BuildEditPassPromptV3Input
} from './editPass.v3'

const MOOD = renderSceneMood('quiet dread', 'debts come due') ?? ''
const base: BuildEditPassPromptV3Input = {
  type: 'continuity',
  text: 'Mara had green eyes. She waited at the landing.',
  title: 'The ferry landing',
  part: { index: 0, count: 1 },
  voice: null,
  keepWords: [],
  instruction: null,
  mood: MOOD,
  storyNotes: FIXTURE_STORY_NOTES
}

describe('editPass.v3 prompt (F-16.14)', () => {
  it('checks a continuity pass against the Story notes in place of the numbered references', () => {
    const built = buildEditPassPromptV3(base)
    expect(built.version).toBe(EDIT_PASS_PROMPT_V3_VERSION)
    expect(built.messages).toMatchSnapshot()
    const [system, user] = built.messages.map((m) => m.content)
    expect(system?.startsWith(EDIT_PASS_SENTINEL)).toBe(true)
    expect(system).toContain(EDIT_PASS_V3_CONTINUITY_TASK)
    expect(system).not.toContain(EDIT_PASS_TASKS.continuity)
    // The continuity pass never carries the mood; the notes open the user turn.
    expect(user?.startsWith(`${STORY_NOTES_HEADING}\n`)).toBe(true)
    expect(user).not.toContain('References:')
    expect(user).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(user).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("is version 2's messages exactly for every other pass type", () => {
    for (const type of EDIT_PASS_TYPES.filter((each) => each !== 'continuity')) {
      const input = { ...base, type, instruction: type === 'custom' ? 'Tighten it.' : null }
      const v2 = buildEditPassPromptV2({ ...input, references: [] })
      const v3 = buildEditPassPromptV3(input)
      expect(v3.messages, type).toEqual(v2.messages)
      expect(v3.messages.map((m) => m.content).join('\n')).not.toContain(STORY_NOTES_HEADING)
    }
  })
})
