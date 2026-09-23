import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  IMPORT_CHUNK_WORDS,
  STRUCTURE_PARAGRAPH_HEAD,
  STRUCTURE_PARAGRAPH_TAIL
} from '@shared/importStructure'
import { buildImportStructurePrompt, type StructurePromptParagraph } from './importStructure.v1'

const paragraph = (
  index: number,
  text: string,
  over: Partial<StructurePromptParagraph> = {}
): StructurePromptParagraph => ({
  index,
  text,
  sceneStart: false,
  chapterStart: false,
  sceneTitle: 'Scene 1',
  chapterTitle: 'Chapter One',
  ...over
})

const fixture = {
  tagNames: ['dark-forest', 'protagonist', 'melancholy'],
  paragraphs: [
    paragraph(4, 'The ferry landing was empty when Mara reached it.', {
      sceneStart: true,
      chapterStart: true
    }),
    paragraph(5, 'She set the lantern down on the post and waited.'),
    paragraph(6, 'Three days later the thaw came.', {
      sceneStart: true,
      sceneTitle: 'Scene 2'
    })
  ]
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('importStructure.v1 prompt (F-12.3)', () => {
  it('matches the golden messages for the fixture chunk and asks for the feature output budget', () => {
    const built = buildImportStructurePrompt(fixture)
    expect(built.version).toBe('importStructure.v1')
    expect(built.maxTokens).toBe(outputBudget('importStructure'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('importStructure'))
  })

  it('numbers every paragraph with its global index and marks the boundaries the draft has', () => {
    const user = buildImportStructurePrompt(fixture).messages[1]?.content ?? ''
    expect(user).toContain('Tag bank: dark-forest, protagonist, melancholy')
    expect(user.slice(user.indexOf('Paragraphs:\n'))).toBe(
      'Paragraphs:\n' +
        '— chapter starts here: "Chapter One" —\n' +
        '— scene starts here: "Scene 1" —\n' +
        '[4] The ferry landing was empty when Mara reached it.\n' +
        '[5] She set the lantern down on the post and waited.\n' +
        '— scene starts here: "Scene 2" —\n' +
        '[6] Three days later the thaw came.'
    )
  })

  it('shortens a long paragraph to its head and tail, and says so when the bank is empty', () => {
    const long = `${'a'.repeat(STRUCTURE_PARAGRAPH_HEAD)}${'X'.repeat(200)}${'b'.repeat(STRUCTURE_PARAGRAPH_TAIL)}`
    const built = buildImportStructurePrompt({
      tagNames: [],
      paragraphs: [paragraph(0, long, { sceneStart: true, chapterStart: true })]
    })
    const user = built.messages[1]?.content ?? ''
    expect(user).toContain('Tag bank: (none)')
    expect(user).not.toContain('X')
    expect(user).toContain(` … ${'b'.repeat(STRUCTURE_PARAGRAPH_TAIL)}`)
  })

  it('keeps a chunk at the word cap inside the feature input budget', () => {
    // A maxed chunk: `IMPORT_CHUNK_WORDS` words of prose in 50-word paragraphs (every fifth one
    // a scene start, so the markers are paid for too) against the largest bank a template makes.
    const perParagraph = 50
    const prose =
      'the lantern flame stood up again and she counted the seconds until it did not'.split(' ')
    const text = Array.from(
      { length: perParagraph },
      (_, i) => prose[i % prose.length] ?? 'word'
    ).join(' ')
    const count = IMPORT_CHUNK_WORDS / perParagraph
    const built = buildImportStructurePrompt({
      tagNames: Array.from({ length: 60 }, (_, i) => `tag-name-${i}`),
      paragraphs: Array.from({ length: count }, (_, i) =>
        paragraph(i, text, { sceneStart: i % 5 === 0, chapterStart: i === 0 })
      )
    })
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('importStructure'))
  })
})
