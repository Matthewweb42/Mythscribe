import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { IMPORT_CHUNK_WORDS } from '@shared/importStructure'
import {
  buildImportStructurePrompt,
  IMPORT_STRUCTURE_RULES,
  type StructurePromptParagraph
} from './importStructure.v1'
import { buildImportStructurePromptV2, IMPORT_STRUCTURE_V2_RULES } from './importStructure.v2'

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

describe('importStructure.v2 prompt (F-16.15, story memory v2)', () => {
  it('matches the golden messages for the fixture chunk and asks for the feature output budget', () => {
    const built = buildImportStructurePromptV2(fixture)
    expect(built.version).toBe('importStructure.v2')
    expect(built.maxTokens).toBe(outputBudget('importStructure'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('importStructure'))
  })

  it('is version 1 without the tag bank or tags, with the same opening and paragraphs', () => {
    const v2 = buildImportStructurePromptV2(fixture)
    const v1 = buildImportStructurePrompt({ ...fixture, tagNames: ['dark-forest'] })
    const text = promptText(v2.messages)
    expect(text).not.toMatch(/tag/i)
    expect(IMPORT_STRUCTURE_V2_RULES.slice(0, 120)).toBe(IMPORT_STRUCTURE_RULES.slice(0, 120))
    const paragraphsOf = (content: string | undefined): string =>
      (content ?? '').slice((content ?? '').indexOf('Paragraphs:\n'))
    expect(paragraphsOf(v2.messages[1]?.content)).toBe(paragraphsOf(v1.messages[1]?.content))
    expect(estimateTokens(text)).toBeLessThan(estimateTokens(promptText(v1.messages)))
  })

  it('keeps a chunk at the word cap inside the feature input budget', () => {
    const perParagraph = 50
    const prose =
      'the lantern flame stood up again and she counted the seconds until it did not'.split(' ')
    const text = Array.from(
      { length: perParagraph },
      (_, i) => prose[i % prose.length] ?? 'word'
    ).join(' ')
    const built = buildImportStructurePromptV2({
      paragraphs: Array.from({ length: IMPORT_CHUNK_WORDS / perParagraph }, (_, i) =>
        paragraph(i, text, { sceneStart: i % 5 === 0, chapterStart: i === 0 })
      )
    })
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('importStructure'))
  })
})
