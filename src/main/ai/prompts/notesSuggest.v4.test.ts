import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { CARD_PROMPT_HEADING, type PromptCard } from '@shared/memory/cardText'
import { STORY_NOTES_HEADING } from '@shared/memory/storyNotes'
import {
  FIXTURE_STORY_NOTES,
  MAXED_STORY_NOTES,
  STORY_NOTES_IDEA_TEXT,
  STORY_NOTES_NOT_CANON_TEXT
} from '../eval/storyNotesFixture'
import { buildNotesSuggestPromptV3 } from './notesSuggest.v3'
import {
  buildNotesSuggestPromptV4,
  NOTES_SUGGEST_PROMPT_V4_VERSION,
  type BuildNotesSuggestPromptV4Input
} from './notesSuggest.v4'

const CARD: PromptCard = {
  line: 'Mara waits for a ferry that does not come.',
  gist: 'Mara sets the lantern down at the landing and waits while the river rises.',
  where: 'the landing',
  when: 'dusk',
  pov: 'Mara Vell',
  mood: 'tense',
  theme: ''
}

const input: BuildNotesSuggestPromptV4Input = {
  sceneText: 'Mara set the lantern down. The river was rising.',
  card: CARD,
  brief: null,
  notes: 'Tomas is late.',
  storyNotes: FIXTURE_STORY_NOTES,
  instruction: null
}

describe('notesSuggest.v4 prompt (F-16.20, decision P1-D7)', () => {
  it('matches the golden messages: the card in the summary’s place', () => {
    const built = buildNotesSuggestPromptV4(input)
    expect(built.version).toBe(NOTES_SUGGEST_PROMPT_V4_VERSION)
    expect(built.version).toBe('notesSuggest.v4')
    expect(built.messages).toMatchSnapshot()
    const user = built.messages[1]?.content ?? ''
    expect(user).toContain(CARD_PROMPT_HEADING)
    expect(user).not.toContain('Stored summary')
    expect(user.indexOf(CARD_PROMPT_HEADING)).toBeLessThan(user.indexOf('Current notes:'))
    const system = built.messages[0]?.content ?? ''
    expect(system).toContain(STORY_NOTES_HEADING)
    expect(system).not.toContain(STORY_NOTES_IDEA_TEXT)
    expect(system).not.toContain(STORY_NOTES_NOT_CANON_TEXT)
  })

  it("keeps version 3's system turn byte for byte (the cached prefix) and its caps", () => {
    const v3 = buildNotesSuggestPromptV3({ ...input, summary: null })
    const v4 = buildNotesSuggestPromptV4(input)
    expect(v4.messages[0]).toEqual(v3.messages[0])
    expect(v4.maxTokens).toBe(outputBudget('notesSuggest'))
    // With no card the user turn is version 3's with no summary.
    expect(buildNotesSuggestPromptV4({ ...input, card: null }).messages[1]).toEqual(v3.messages[1])
  })

  it('stays under its input budget with every part at its cap', () => {
    const maxed = buildNotesSuggestPromptV4({
      sceneText: 'x'.repeat(12_000),
      card: { ...CARD, line: 'l'.repeat(250), gist: 'g'.repeat(700) },
      brief: 'b'.repeat(1_200),
      notes: 'n'.repeat(1_500),
      storyNotes: MAXED_STORY_NOTES,
      instruction: 'i'.repeat(400)
    })
    expect(estimateTokens(maxed.messages.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(
      inputBudget('notesSuggest')
    )
  })
})
