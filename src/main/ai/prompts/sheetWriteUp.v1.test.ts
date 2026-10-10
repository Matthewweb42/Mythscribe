import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { WRITE_UP_MAX_TOKENS } from '@shared/sheetSync'
import {
  buildSheetWriteUpPrompt,
  SHEET_WRITE_UP_PROMPT_VERSION,
  SHEET_WRITE_UP_RULES
} from './sheetWriteUp.v1'

const FIELDS = [
  { id: 'age', label: 'Age', value: '27', heading: false },
  { id: 'born', label: 'Born (story year)', value: '  ', heading: false },
  { id: 'appearance', label: 'Appearance', value: 'A scar over her left eye.', heading: true },
  { id: 'notes', label: 'Notes', value: '', heading: true }
]

describe('sheetWriteUp.v1 prompt (F-9.18)', () => {
  it('puts the rules in the system turn and the sheet in the user turn, empty fields left out', () => {
    const built = buildSheetWriteUpPrompt({
      name: 'Mara',
      noun: 'character',
      length: 'medium',
      fields: FIELDS
    })
    expect(SHEET_WRITE_UP_PROMPT_VERSION).toBe('sheetWriteUp.v1')
    expect(built.version).toBe('sheetWriteUp.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: SHEET_WRITE_UP_RULES },
      {
        role: 'user',
        content:
          'Sheet: Mara (character)\n' +
          'Word target: at most 250\n' +
          'Paragraph fields: age\n' +
          'Heading fields: appearance\n' +
          'Fields:\n[age] Age: 27\n[appearance] Appearance: A scar over her left eye.\n' +
          'Write the page.'
      }
    ])
    expect(
      SHEET_WRITE_UP_RULES.startsWith(
        'You are the sheet write-up feature inside a novel-writing app.'
      )
    ).toBe(true)
    expect(SHEET_WRITE_UP_RULES).toContain('{"intro":"...","parts":{"id":"..."}}')
    expect('temperature' in built).toBe(false)
  })

  it('says none when no field goes under a heading or into the paragraphs', () => {
    const built = buildSheetWriteUpPrompt({
      name: 'Mara',
      noun: 'character',
      length: 'short',
      fields: FIELDS.slice(0, 1)
    })
    expect(built.messages[1]?.content).toContain('Paragraph fields: age\nHeading fields: none')
    expect(built.messages[1]?.content).toContain('Word target: at most 120')
  })

  it('asks the length’s output cap, within the feature budget, and costs what the golden says', () => {
    for (const length of ['short', 'medium', 'long'] as const) {
      const built = buildSheetWriteUpPrompt({
        name: 'Mara',
        noun: 'character',
        length,
        fields: FIELDS
      })
      expect(built.maxTokens).toBe(WRITE_UP_MAX_TOKENS[length])
      expect(built.maxTokens).toBeLessThanOrEqual(outputBudget('sheetSync'))
    }
    const built = buildSheetWriteUpPrompt({
      name: 'Mara',
      noun: 'character',
      length: 'medium',
      fields: FIELDS
    })
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(223)
  })
})
