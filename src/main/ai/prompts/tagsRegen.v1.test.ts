import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { TAGS_TEXT_CHAR_BUDGET, buildTagsPrompt } from './tags.v1'
import { TAGS_REGEN_CLAUSE_PREFIX, buildTagsRegenPrompt } from './tagsRegen.v1'

const fixture = {
  text:
    'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
    'lightning gaps, each one shorter than the last. Somewhere ahead, past the black trunks, the ' +
    'river she had to cross was rising.',
  tagNames: ['dark-forest', 'protagonist', 'melancholy']
}
const NOTE = 'Too much about the setting; this scene is about Mara.'

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('tagsRegen.v1 prompt (F-14.5)', () => {
  it('is tags.v1 with the note clause appended to the system turn, the user turn untouched', () => {
    const base = buildTagsPrompt(fixture)
    const built = buildTagsRegenPrompt({ ...fixture, note: NOTE })
    expect(built.version).toBe('tagsRegen.v1')
    expect(built.maxTokens).toBe(outputBudget('tags'))
    expect(built.messages[1]).toEqual(base.messages[1])
    expect(built.messages[0]?.content.startsWith(base.messages[0]?.content ?? '!')).toBe(true)
    expect(built.messages).toMatchSnapshot()
    expect(TAGS_REGEN_CLAUSE_PREFIX).toBe('The writer asked for a different set')
  })

  it('says only that a different set was asked for when the note is blank', () => {
    const built = buildTagsRegenPrompt({ ...fixture, note: null })
    const system = built.messages[0]?.content ?? ''
    expect(system).toContain(`${TAGS_REGEN_CLAUSE_PREFIX}.`)
    expect(system).not.toContain('said:')
    expect(built.messages).toMatchSnapshot()
  })

  it('stays under the tags input budget with a passage at the cut and the longest note', () => {
    const built = buildTagsRegenPrompt({
      text: 'x'.repeat(TAGS_TEXT_CHAR_BUDGET + 500),
      tagNames: Array.from({ length: 60 }, (_, i) => `tag-name-${i}`),
      note: 'n'.repeat(PROPOSAL_NOTE_MAX)
    })
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('tags'))
  })
})
