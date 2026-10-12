import { describe, expect, it } from 'vitest'
import { ALL_BUILTIN_CATEGORIES } from '../categories'
import { defaultCaseRule, recordKindOf, type RecordKind } from './records'

describe('recordKindOf (F-16.4)', () => {
  it('maps every built-in category to its kind', () => {
    const expected: Record<string, RecordKind> = {
      character: 'character',
      setting: 'place',
      faction: 'group',
      thread: 'thread',
      magic: 'term',
      religion: 'term',
      culture: 'term',
      history: 'term',
      language: 'term',
      technology: 'term',
      lore: 'term',
      world: 'thing',
      item: 'thing',
      creature: 'thing'
    }
    for (const category of ALL_BUILTIN_CATEGORIES) {
      expect(recordKindOf(category.id), category.id).toBe(expected[category.id])
    }
  })

  it('makes the v2 secret category a secret (P2b-D1)', () => {
    expect(recordKindOf('secret')).toBe('secret')
  })

  it('makes every custom category a thing', () => {
    expect(recordKindOf('c-ships')).toBe('thing')
    expect(recordKindOf('c-houses-of-the-north')).toBe('thing')
  })
})

describe('defaultCaseRule', () => {
  it('matches a name typed without a capital in any case, any other by the automatic rule', () => {
    expect(defaultCaseRule('the grey men')).toBe('any')
    expect(defaultCaseRule('Mara')).toBe('auto')
  })
})
