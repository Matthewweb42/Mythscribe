import { describe, expect, it } from 'vitest'
import { builtinCategory } from './categories'
import {
  applyRefile,
  chunkParagraphs,
  layoutWriteUp,
  pageEdits,
  paragraphsOf,
  sheetFieldDefs,
  SHEET_EXTRA_FIELDS_MAX
} from './sheetSync'

const character = builtinCategory('character')
if (character === undefined) throw new Error('no character category')

describe('sheet sync text rules (F-9.18)', () => {
  it('splits a page into paragraphs on blank lines', () => {
    expect(paragraphsOf('One.\n\n\nTwo\nlines.\n  \nThree.')).toEqual([
      'One.',
      'Two\nlines.',
      'Three.'
    ])
    expect(paragraphsOf(null)).toEqual([])
  })

  it('tells the paragraphs removed and added, ignoring moves and whitespace', () => {
    expect(pageEdits('A.\n\nB.\n\nC.', 'C.\n\nA.\n\nB  changed.\n\nD.')).toEqual({
      removed: ['B.'],
      added: ['B  changed.', 'D.']
    })
    expect(pageEdits('A  b.', 'A b.')).toEqual({ removed: [], added: [] })
  })

  it('chunks added text by size', () => {
    expect(chunkParagraphs(['aaaa', 'bbbb', 'cc'], 8)).toEqual([['aaaa'], ['bbbb', 'cc']])
    expect(chunkParagraphs(['aa', 'bb', 'cc'], 10)).toEqual([['aa', 'bb', 'cc']])
  })

  it('lays the page out in the author’s style: paragraphs first, then headed fields in field order', () => {
    const fields = sheetFieldDefs(character, [])
    const page = layoutWriteUp(
      fields,
      { length: 'medium', roles: { notes: 'paragraph' } },
      {
        intro: ' Mara is 27. ',
        parts: { background: 'Raised on the river.', appearance: 'A scar.', notes: 'ignored' }
      }
    )
    expect(page).toBe('Mara is 27.\n\nAppearance\nA scar.\n\nBackground\nRaised on the river.')
  })

  it('files edits: replaces found text, adds the rest, and makes fields of the sheet’s own', () => {
    const fields = sheetFieldDefs(character, [])
    const filed = applyRefile(
      fields,
      [],
      { age: '27', appearance: 'Tall. A scar.' },
      [
        { f: 'age', old: '27', new: '28' },
        { f: 'appearance', old: 'A scar.', new: '' },
        { f: 'goals', old: 'not there', new: 'Find her brother.' },
        { f: 'nope', old: '', new: 'dropped' }
      ],
      [
        { label: 'Weapon', value: 'A bone bow.' },
        { label: 'notes', value: 'Fears boats.' }
      ]
    )
    expect(filed.values).toEqual({
      age: '28',
      appearance: 'Tall.',
      goals: 'Find her brother.',
      weapon: 'A bone bow.',
      notes: 'Fears boats.'
    })
    expect(filed.extra).toEqual([{ id: 'weapon', label: 'Weapon', multiline: true }])
  })

  it('puts an addition into Notes once the sheet has all the fields of its own it may', () => {
    const extra = Array.from({ length: SHEET_EXTRA_FIELDS_MAX }, (_, i) => ({
      id: `own${i}`,
      label: `Own ${i}`,
      multiline: true
    }))
    const filed = applyRefile(
      sheetFieldDefs(character, extra),
      extra,
      {},
      [],
      [{ label: 'Weapon', value: 'A bow.' }]
    )
    expect(filed.extra).toHaveLength(SHEET_EXTRA_FIELDS_MAX)
    expect(filed.values.notes).toBe('Weapon: A bow.')
  })
})
