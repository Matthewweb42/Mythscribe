import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { BUILTIN_CATEGORIES, categoryFromInput, categoryOf } from '@shared/categories'
import { CONTEXT_SHEET_NAMES_CHARS } from '@shared/contextLibrary'
import { CONTEXT_IMPORT_RULES } from './contextImport.v1'
import {
  buildContextImportPromptV2,
  CONTEXT_IMPORT_RULES_V2,
  sheetNamesBlockV2,
  type BuildContextImportPromptV2Input
} from './contextImport.v2'

const ships = categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew', 'Home port'] }, 'ai')

const fixture: BuildContextImportPromptV2Input = {
  categories: [...BUILTIN_CATEGORIES, ships],
  sheets: [
    { category: categoryOf('character'), names: ['Mara Vell', 'Tomas'] },
    { category: categoryOf('setting'), names: [] },
    { category: categoryOf('magic'), names: ['The Weave'] }
  ],
  images: ['mara-portrait.png'],
  fileName: 'notes.md',
  part: 1,
  parts: 1,
  changedOnly: false,
  text: 'The Weave costs a memory per knot.\n\nThe Gull: a cutter, crew of twelve.'
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('contextImport.v2 prompt (F-9.11)', () => {
  it('matches the golden messages for the fixture and asks for the feature output budget', () => {
    const built = buildContextImportPromptV2(fixture)
    expect(built.version).toBe('contextImport.v2')
    expect(built.maxTokens).toBe(outputBudget('contextImport'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(promptText(built.messages))).toBeLessThan(inputBudget('contextImport'))
  })

  it('keeps version 1’s opening sentence, which the e2e fake recognises', () => {
    const opening = CONTEXT_IMPORT_RULES.slice(0, 80)
    expect(CONTEXT_IMPORT_RULES_V2.startsWith(opening)).toBe(true)
  })

  it('lists every library category with its fields, Notes left out, and the leave to propose one', () => {
    for (const category of BUILTIN_CATEGORIES) {
      expect(CONTEXT_IMPORT_RULES_V2).toContain(`${category.id} (${category.hint}): `)
    }
    expect(CONTEXT_IMPORT_RULES_V2).toContain(
      'magic (magic, powers, and how they work): description, source'
    )
    expect(CONTEXT_IMPORT_RULES_V2).not.toMatch(/, notes[;.]/)
    expect(CONTEXT_IMPORT_RULES_V2).toContain('"categories"')
  })

  it('puts the project’s own categories, then the sheets that exist, then images, then the document', () => {
    const user = buildContextImportPromptV2(fixture).messages[1]?.content ?? ''
    expect(user).toBe(
      "The project's own categories:\nc-ships (Ships): crew, homePort\n\n" +
        'Existing sheets by kind:\ncharacter: Mara Vell, Tomas\nmagic: The Weave\n\n' +
        'Images: mara-portrait.png\n\n' +
        'Document "notes.md":\n' +
        fixture.text
    )
  })

  it('leaves the project block out when the project has no categories of its own', () => {
    const user =
      buildContextImportPromptV2({ ...fixture, categories: BUILTIN_CATEGORIES }).messages[1]
        ?.content ?? ''
    expect(user.startsWith('Existing sheets by kind:')).toBe(true)
  })

  it('cuts the sheet names to their budget and says none when there are none', () => {
    const many = Array.from({ length: 400 }, (_, i) => `Name ${i}`.padEnd(40, 'x'))
    const block = sheetNamesBlockV2([
      { category: categoryOf('character'), names: many },
      { category: categoryOf('setting'), names: many }
    ])
    expect(block.length).toBeLessThan(CONTEXT_SHEET_NAMES_CHARS + 100)
    expect(block).not.toContain('setting:')
    expect(sheetNamesBlockV2([])).toBe('(none)')
  })
})
