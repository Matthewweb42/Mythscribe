import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { TAGS_TEXT_CHAR_BUDGET, buildTagsPrompt } from './tags.v1'

/** A ~200-character scene, the shape a short scene's `docToText` has. */
const fixture = {
  text:
    'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
    'lightning gaps, each one shorter than the last. Somewhere ahead, past the black trunks, the ' +
    'river she had to cross was rising.',
  tagNames: ['dark-forest', 'protagonist', 'melancholy']
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('tags.v1 prompt (F-4.7)', () => {
  it('matches the golden messages for the fixture and asks for the tags output budget', () => {
    const built = buildTagsPrompt(fixture)
    expect(built.version).toBe('tags.v1')
    expect(built.maxTokens).toBe(outputBudget('tags'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('tags'))
  })

  it('keeps the first TAGS_TEXT_CHAR_BUDGET characters of a long passage and marks the cut', () => {
    const long = { ...fixture, text: 'x'.repeat(TAGS_TEXT_CHAR_BUDGET + 500) }
    const built = buildTagsPrompt(long)
    const user = built.messages[1]?.content ?? ''
    const passage = user.slice(user.indexOf('Passage:\n') + 'Passage:\n'.length)
    expect(passage.endsWith('…')).toBe(true)
    expect(passage).toHaveLength(TAGS_TEXT_CHAR_BUDGET + 1)
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('tags'))
  })

  it('sends a passage at the budget untouched', () => {
    const exact = { ...fixture, text: 'y'.repeat(TAGS_TEXT_CHAR_BUDGET) }
    expect(buildTagsPrompt(exact).messages[1]?.content.endsWith('y')).toBe(true)
  })
})
