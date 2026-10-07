import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CONTEXT_CHUNK_CHARS,
  CONTEXT_IMAGE_NAMES_MAX,
  CONTEXT_SHEET_NAMES_CHARS
} from '@shared/contextLibrary'
import { ENTITY_NAME_MAX } from '@shared/entities'
import {
  buildContextImportPrompt,
  CONTEXT_IMPORT_RULES,
  sheetNamesBlock,
  type BuildContextImportPromptInput
} from './contextImport.v1'

const fixture: BuildContextImportPromptInput = {
  sheets: { character: ['Mara Vell', 'Tomas'], setting: ['The Ferry Landing'], world: [] },
  images: ['mara-portrait.png'],
  fileName: 'characters.md',
  part: 1,
  parts: 1,
  changedOnly: false,
  text: 'Mara Vell, called Mara, is thirty-four.\n\nThe Elm Court: the old guild of ferrymen.'
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('contextImport.v1 prompt (F-9.8)', () => {
  it('matches the golden messages for the fixture and asks for the feature output budget', () => {
    const built = buildContextImportPrompt(fixture)
    expect(built.version).toBe('contextImport.v1')
    expect(built.maxTokens).toBe(outputBudget('contextImport'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('contextImport'))
  })

  it('puts the rules first, then the sheets and images, then the document', () => {
    const built = buildContextImportPrompt({ ...fixture, part: 2, parts: 3, changedOnly: true })
    expect(built.messages[0]).toEqual({ role: 'system', content: CONTEXT_IMPORT_RULES })
    expect(built.messages[1]?.content).toBe(
      'Existing sheets:\nCharacters: Mara Vell, Tomas\nSettings: The Ferry Landing\nWorld: (none)\n\n' +
        'Images: mara-portrait.png\n\n' +
        'Document "characters.md" (part 2 of 3), only the passages new since it was last sorted:\n' +
        fixture.text
    )
  })

  it('never offers the Notes field, which takes the details', () => {
    expect(CONTEXT_IMPORT_RULES).toContain('character: age, born, gender, appearance')
    expect(CONTEXT_IMPORT_RULES).not.toMatch(/relationships, notes/)
  })

  it('cuts the sheet names to their budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => `Name ${i}`.padEnd(40, 'x'))
    const block = sheetNamesBlock({ character: many, setting: many, world: many })
    expect(block.length).toBeLessThan(CONTEXT_SHEET_NAMES_CHARS + 100)
    expect(block).toContain('Settings: (none)')
  })

  it('keeps a full chunk with every list at its cap inside the feature input budget', () => {
    const name = 'n'.repeat(ENTITY_NAME_MAX / 4)
    const built = buildContextImportPrompt({
      sheets: {
        character: Array.from({ length: 200 }, () => name),
        setting: [],
        world: []
      },
      images: Array.from({ length: CONTEXT_IMAGE_NAMES_MAX + 10 }, (_, i) => `image-${i}.png`),
      fileName: 'world.docx',
      part: 1,
      parts: 4,
      changedOnly: false,
      text: 'word '.repeat(CONTEXT_CHUNK_CHARS / 5)
    })
    expect(built.messages[1]?.content).not.toContain(`image-${CONTEXT_IMAGE_NAMES_MAX}.png`)
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('contextImport'))
  })
})
