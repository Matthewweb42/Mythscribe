import { describe, expect, it } from 'vitest'
import { ENTITY_FIELD_MAX } from '@shared/entities'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex } from '@renderer/features/manuscript/treeStore'
import {
  isOnSheet,
  readingOrder,
  sheetTarget,
  sheetTextAt,
  withFactAdded
} from './observedFactView'

describe('observedFactView (F-5.16)', () => {
  it('readingOrder lists every document by section, then position', () => {
    expect(readingOrder(buildIndex(treeFixture))).toEqual([
      'title-page',
      'sc-1',
      'sc-2',
      'sc-3',
      'sc-4',
      'sc-5',
      'sc-6'
    ])
  })

  it('sheetTarget is the mapped field, the page of a blank template, or nothing', () => {
    expect(sheetTarget({ kind: 'character', template: 'structured' }, 'age')).toEqual({
      type: 'field',
      field: 'age',
      multiline: false
    })
    expect(sheetTarget({ kind: 'character', template: 'structured' }, 'goals')).toEqual({
      type: 'field',
      field: 'goals',
      multiline: true
    })
    expect(sheetTarget({ kind: 'character', template: 'blank' }, 'age')).toEqual({ type: 'body' })
    // `rules` is a world attribute: a character sheet has no field for it.
    expect(sheetTarget({ kind: 'character', template: 'structured' }, 'rules')).toBeNull()
    expect(sheetTarget({ kind: 'character', template: 'structured' }, 'notes')).toBeNull()
  })

  it('isOnSheet ignores case, spacing, and closing punctuation', () => {
    expect(isOnSheet('Tall, with  GREY eyes and a scar.', 'Grey eyes.')).toBe(true)
    expect(isOnSheet('Tall.', 'Grey eyes')).toBe(false)
    expect(isOnSheet('', 'Grey eyes')).toBe(false)
    expect(isOnSheet('anything', ' . ')).toBe(false)
  })

  it('withFactAdded appends on a new line, with `; ` in a one-line field, labelled on the page', () => {
    const sheet = { fields: { age: '27', appearance: 'Tall.\n' }, body: 'A mapmaker.' }
    const kind = { kind: 'character' } as const
    const age = { type: 'field', field: 'age', multiline: false } as const
    const appearance = { type: 'field', field: 'appearance', multiline: true } as const
    const goals = { type: 'field', field: 'goals', multiline: true } as const
    expect(sheetTextAt(sheet, goals)).toBe('')
    expect(withFactAdded(kind, sheet, age, 'age', '34')).toBe('27; 34')
    expect(withFactAdded(kind, sheet, appearance, 'appearance', 'Grey eyes')).toBe(
      'Tall.\nGrey eyes'
    )
    expect(withFactAdded(kind, sheet, goals, 'goals', 'Find the chart')).toBe('Find the chart')
    expect(withFactAdded(kind, sheet, { type: 'body' }, 'goals', 'Find the chart')).toBe(
      'A mapmaker.\nGoals / motivations: Find the chart'
    )
  })

  it('withFactAdded refuses what would not fit the column', () => {
    const full = { fields: { appearance: 'x'.repeat(ENTITY_FIELD_MAX - 3) }, body: '' }
    expect(
      withFactAdded(
        { kind: 'character' },
        full,
        { type: 'field', field: 'appearance', multiline: true },
        'appearance',
        'Grey eyes'
      )
    ).toBeNull()
  })
})
