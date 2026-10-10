import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { REFILE_MAX_TOKENS } from '@shared/sheetSync'
import {
  buildSheetRefilePrompt,
  SHEET_REFILE_PROMPT_VERSION,
  SHEET_REFILE_RULES
} from './sheetRefile.v1'

const FIELDS = [
  { id: 'age', label: 'Age', value: '27' },
  { id: 'notes', label: 'Notes', value: '' }
]

describe('sheetRefile.v1 prompt (F-9.18)', () => {
  it('sends the fields, empty ones marked, and the page edits after them', () => {
    const built = buildSheetRefilePrompt({
      name: 'Mara',
      noun: 'character',
      fields: FIELDS,
      removed: ['Mara is 27.'],
      added: ['Mara is 28.', 'She fears boats.']
    })
    expect(SHEET_REFILE_PROMPT_VERSION).toBe('sheetRefile.v1')
    expect(built.version).toBe('sheetRefile.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: SHEET_REFILE_RULES },
      {
        role: 'user',
        content:
          'Sheet: Mara (character)\n\n' +
          'Fields:\n[age] Age: 27\n[notes] Notes: (empty)\n\n' +
          'Removed from the page:\n"""\nMara is 27.\n"""\n\n' +
          'Added to the page:\n"""\nMara is 28.\n\nShe fears boats.\n"""\n\n' +
          'File the edits.'
      }
    ])
    expect(
      SHEET_REFILE_RULES.startsWith('You are the sheet filing feature inside a novel-writing app.')
    ).toBe(true)
    expect(SHEET_REFILE_RULES).toContain('{"edits":[{"f":"id","old":"...","new":"..."}]')
  })

  it('leaves out an empty side of the edits', () => {
    const built = buildSheetRefilePrompt({
      name: 'Mara',
      noun: 'character',
      fields: FIELDS,
      removed: [],
      added: ['She fears boats.']
    })
    expect(built.messages[1]?.content).not.toContain('Removed from the page')
  })

  it('asks the filing cap, within the feature budget, and costs what the golden says', () => {
    const built = buildSheetRefilePrompt({
      name: 'Mara',
      noun: 'character',
      fields: FIELDS,
      removed: ['Mara is 27.'],
      added: ['Mara is 28.']
    })
    expect(built.maxTokens).toBe(REFILE_MAX_TOKENS)
    expect(built.maxTokens).toBeLessThanOrEqual(outputBudget('sheetSync'))
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(239)
  })
})
