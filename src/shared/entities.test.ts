import { describe, expect, it } from 'vitest'
import {
  EntityFieldId,
  EntityKind,
  entityTagName,
  parseEntityFields,
  toEntityNameKey,
  WORLD_CATEGORY_SUGGESTIONS
} from './entities'
import { TAG_NAME_MAX } from './tags'

describe('the id shapes (F-9.11)', () => {
  it('take every category id, the F-9.1 kinds and project ones among them', () => {
    for (const id of ['character', 'setting', 'world', 'magic', 'c-ships', 'c-ships-2']) {
      expect(EntityKind.safeParse(id).success).toBe(true)
    }
    for (const id of ['', 'Ships', 'c ships', '-x', 'a'.repeat(49)]) {
      expect(EntityKind.safeParse(id).success).toBe(false)
    }
  })

  it('take camel-case field ids and refuse anything else', () => {
    expect(EntityFieldId.safeParse('associatedCharacters').success).toBe(true)
    expect(EntityFieldId.safeParse('homePort2').success).toBe(true)
    expect(EntityFieldId.safeParse('Home port').success).toBe(false)
    expect(EntityFieldId.safeParse('').success).toBe(false)
  })

  it('suggest world categories without making the field a list', () => {
    expect(WORLD_CATEGORY_SUGGESTIONS).toContain('Magic system')
  })
})

describe('toEntityNameKey', () => {
  it.each([
    ['  Ada   Lovelace ', 'ada lovelace'],
    ['Ada Lovelace', 'ada lovelace'],
    ['ada lovelace', 'ada lovelace'],
    ['ADA\tLOVELACE', 'ada lovelace'],
    ['Ada\nLovelace', 'ada lovelace'],
    ['Zoë', 'zoë'],
    ['Zoë', 'zoë'],
    ['   ', ''],
    ['', '']
  ])('%j → %j', (input, expected) => {
    expect(toEntityNameKey(input)).toBe(expected)
  })

  it('keeps punctuation, which is part of a name here and not a separator', () => {
    expect(toEntityNameKey("O'Rourke")).toBe("o'rourke")
    expect(toEntityNameKey('Sidi-ath')).toBe('sidi-ath')
    expect(toEntityNameKey('The Salt Marsh, North')).toBe('the salt marsh, north')
  })
})

describe('the tag link (F-9.4)', () => {
  it.each([
    ['Mara Vell', 'mara-vell'],
    ['  Mara  ', 'mara'],
    ['Zoë', 'zoë'],
    ['The Salt Marsh, North', 'the-salt-marsh-north'],
    ['???', ''],
    ['', '']
  ])('kebab-cases %j → %j', (input, expected) => {
    expect(entityTagName(input)).toBe(expected)
  })

  it('cuts a long name to the tag limit and leaves no trailing hyphen', () => {
    const long = entityTagName('a'.repeat(TAG_NAME_MAX + 20))
    expect(long).toBe('a'.repeat(TAG_NAME_MAX))
    // The cut falls on a separator here, so the hyphen it would leave is trimmed.
    const cutOnSeparator = entityTagName(`${'a'.repeat(TAG_NAME_MAX)} Vell`)
    expect(cutOnSeparator).toBe('a'.repeat(TAG_NAME_MAX))
    expect(entityTagName(`${'a'.repeat(TAG_NAME_MAX - 1)} Vell`)).toBe('a'.repeat(TAG_NAME_MAX - 1))
    expect(entityTagName(`${'a'.repeat(TAG_NAME_MAX - 5)} Vell`)).toBe(
      `${'a'.repeat(TAG_NAME_MAX - 5)}-vell`
    )
  })
})

describe('parseEntityFields', () => {
  it('reads every stored value under a well-formed field id, whatever the category (F-9.11)', () => {
    const raw = JSON.stringify({ age: '31', atmosphere: 'Damp', homePort: 'Kael' })
    expect(parseEntityFields(raw)).toEqual({ age: '31', atmosphere: 'Damp', homePort: 'Kael' })
  })

  it('drops keys that are not field ids', () => {
    const raw = JSON.stringify({ age: '31', 'Home port': 'Kael', '': 'x' })
    expect(parseEntityFields(raw)).toEqual({ age: '31' })
  })

  it('drops values that are not strings, and empty ones', () => {
    const raw = JSON.stringify({
      age: 31,
      gender: null,
      appearance: ['tall'],
      personality: { warm: true },
      background: '',
      notes: 'Keeps the key.'
    })
    expect(parseEntityFields(raw)).toEqual({ notes: 'Keeps the key.' })
  })

  it('reads null, invalid JSON, and JSON that is not an object as nothing at all', () => {
    expect(parseEntityFields(null)).toEqual({})
    expect(parseEntityFields('')).toEqual({})
    expect(parseEntityFields('{oops')).toEqual({})
    expect(parseEntityFields('"a string"')).toEqual({})
    expect(parseEntityFields('42')).toEqual({})
    expect(parseEntityFields('null')).toEqual({})
    expect(parseEntityFields('{}')).toEqual({})
  })
})
