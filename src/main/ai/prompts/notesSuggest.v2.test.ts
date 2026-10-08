import { describe, expect, it } from 'vitest'
import { outputBudget } from '@shared/ai'
import { NOTES_SUGGEST_RULES, buildNotesSuggestPrompt } from './notesSuggest.v1'
import {
  NOTES_SUGGEST_PROMPT_V2_VERSION,
  NOTES_SUGGEST_TIME_RULE,
  buildNotesSuggestPromptV2
} from './notesSuggest.v2'

const input = {
  sceneText: 'Mara waited by the elm.',
  summary: { summary: 'Mara waits.', keyPoints: ['She is alone.'] },
  brief: 'BRIEF',
  notes: 'Keep the elm.',
  bible: 'BIBLE',
  instruction: null
}

describe('notesSuggest.v2 prompt (F-5.23 story time)', () => {
  it('adds the time rule after v1’s rules, then the bible; the user turn is v1’s', () => {
    const built = buildNotesSuggestPromptV2(input)
    expect(built.version).toBe(NOTES_SUGGEST_PROMPT_V2_VERSION)
    expect(built.maxTokens).toBe(outputBudget('notesSuggest'))
    expect(built.messages).toEqual([
      { role: 'system', content: `${NOTES_SUGGEST_RULES} ${NOTES_SUGGEST_TIME_RULE}\n\nBIBLE` },
      buildNotesSuggestPrompt(input).messages[1]
    ])
    expect(NOTES_SUGGEST_TIME_RULE).toMatchSnapshot()
  })

  it('leaves the bible out when there is none', () => {
    const built = buildNotesSuggestPromptV2({ ...input, bible: null })
    expect(built.messages[0]?.content).toBe(`${NOTES_SUGGEST_RULES} ${NOTES_SUGGEST_TIME_RULE}`)
  })
})
