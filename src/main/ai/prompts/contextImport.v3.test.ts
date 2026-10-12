import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { BUILTIN_CATEGORIES, categoryFromInput, categoryOf } from '@shared/categories'
import { CONTEXT_SHEET_NAMES_CHARS } from '@shared/contextLibrary'
import {
  buildContextImportPromptV3,
  CONTEXT_IMPORT_RULES_V3,
  FILING_SENTINEL,
  rosterBlockV3,
  type BuildContextImportPromptV3Input
} from './contextImport.v3'

const ships = categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'ai')

const fixture: BuildContextImportPromptV3Input = {
  categories: [...BUILTIN_CATEGORIES, ships],
  roster: [
    {
      category: categoryOf('character'),
      records: [
        { name: 'Mara Vell', aliases: ['Mara', 'the Captain'] },
        { name: 'Tomas Harrow', aliases: [] }
      ]
    },
    { category: categoryOf('setting'), records: [] }
  ],
  images: ['wight.png'],
  title: 'Bestiary',
  part: 1,
  parts: 2,
  text: 'The fen-wight is a pale thing that hunts by lantern-light.\n\nMara Vell has grey eyes.'
}

const all = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('contextImport.v3 prompt (F-16.9)', () => {
  it('matches the golden messages for the fixture and asks for the feature output budget', () => {
    const built = buildContextImportPromptV3(fixture)
    expect(built.version).toBe('contextImport.v3')
    expect(built.maxTokens).toBe(outputBudget('contextImport'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(all(built.messages))).toBeLessThan(inputBudget('contextImport'))
  })

  it('opens with the filing sentence the e2e fake recognises, and asks for a quote per line', () => {
    expect(CONTEXT_IMPORT_RULES_V3.startsWith(FILING_SENTINEL)).toBe(true)
    expect(FILING_SENTINEL).toBe(
      "You are the filing feature inside a novel-writing app, filing the author's research " +
        "document into the pinned notes of their story's records."
    )
    expect(CONTEXT_IMPORT_RULES_V3).toContain('"q"')
    expect(CONTEXT_IMPORT_RULES_V3).toContain('3 to 40 words')
    expect(CONTEXT_IMPORT_RULES_V3).not.toContain('"notes"')
  })

  it('lists the own categories, the records with their nicknames, the images, then the document', () => {
    const user = buildContextImportPromptV3(fixture).messages[1]?.content ?? ''
    expect(user).toBe(
      "The project's own categories:\nc-ships (Ships)\n\n" +
        'Records by category:\ncharacter: Mara Vell (Mara, the Captain); Tomas Harrow\n\n' +
        'Images: wight.png\n\n' +
        `Document "Bestiary" (part 1 of 2):\n${fixture.text}`
    )
  })

  it('cuts the roster to its character budget', () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({ name: `Person ${i}`, aliases: [] }))
    const block = rosterBlockV3([{ category: categoryOf('character'), records: many }])
    expect(block.length).toBeLessThanOrEqual(CONTEXT_SHEET_NAMES_CHARS + 'character: '.length)
    expect(rosterBlockV3([])).toBe('(none)')
  })
})
