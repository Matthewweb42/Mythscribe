import { describe, expect, it } from 'vitest'
import {
  ALIASES_MAX,
  aliasKey,
  findByNameOrAlias,
  normalizeAliases,
  parseAliases,
  tagNameAsAlias
} from './aliases'

describe('aliases (F-4.14)', () => {
  it('keys an alias like a tag name', () => {
    expect(aliasKey('High  Crown Falsire')).toBe('high-crown-falsire')
    expect(aliasKey('???')).toBe('')
  })

  it('normalizes a list: cleaned, first spelling kept, the main name and empties dropped, capped', () => {
    expect(
      normalizeAliases(
        ['  Rynna ', 'rynna', 'Rynna Falsire', '???', 'High   Crown'],
        'rynna-falsire'
      )
    ).toEqual(['Rynna', 'High Crown'])
    const many = Array.from({ length: ALIASES_MAX + 5 }, (_, i) => `Name ${i}`)
    expect(normalizeAliases(many, 'x')).toHaveLength(ALIASES_MAX)
  })

  it('reads a stored cell leniently', () => {
    expect(parseAliases('["Rynna",3]')).toEqual(['Rynna'])
    expect(parseAliases('not json')).toEqual([])
    expect(parseAliases(null)).toEqual([])
    expect(parseAliases('{}')).toEqual([])
  })

  it('finds by main name before another item’s alias', () => {
    const items = [
      { name: 'rynna-falsire', aliases: ['Rynna'] },
      { name: 'rynna', aliases: [] }
    ]
    expect(findByNameOrAlias(items, 'Rynna')).toBe(items[1])
    expect(findByNameOrAlias(items.slice(0, 1), 'RYNNA')).toBe(items[0])
    expect(findByNameOrAlias(items, 'Kael')).toBeUndefined()
  })

  it('spells a kebab name as words', () => {
    expect(tagNameAsAlias('high-crown')).toBe('High Crown')
  })
})
