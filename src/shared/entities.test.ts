import { describe, expect, it } from 'vitest'
import {
  ENTITY_FIELD_IDS,
  ENTITY_FIELDS,
  ENTITY_KIND_LABEL,
  ENTITY_KIND_NOUN,
  ENTITY_KINDS,
  ENTITY_KINDS_WITH_IMAGE,
  fieldIdsFor,
  isFieldOf,
  kindHasImage,
  parseEntityFields,
  toEntityNameKey,
  WORLD_CATEGORY_SUGGESTIONS
} from './entities'

describe('the kinds', () => {
  it('are the three of the spec, each with a label and a noun', () => {
    expect(ENTITY_KINDS).toEqual(['character', 'setting', 'world'])
    for (const kind of ENTITY_KINDS) {
      expect(ENTITY_KIND_LABEL[kind]).toMatch(/\S/)
      expect(ENTITY_KIND_NOUN[kind]).toMatch(/\S/)
    }
  })

  it('carry an image for characters and settings only', () => {
    expect(ENTITY_KINDS_WITH_IMAGE).toEqual(['character', 'setting'])
    expect(kindHasImage('character')).toBe(true)
    expect(kindHasImage('setting')).toBe(true)
    expect(kindHasImage('world')).toBe(false)
  })
})

describe('the templates', () => {
  it('give every kind the spec’s fields, each with a label', () => {
    expect(fieldIdsFor('character')).toEqual([
      'age',
      'gender',
      'appearance',
      'personality',
      'background',
      'goals',
      'relationships',
      'notes'
    ])
    expect(fieldIdsFor('setting')).toEqual([
      'type',
      'description',
      'atmosphere',
      'features',
      'associatedCharacters',
      'notes'
    ])
    expect(fieldIdsFor('world')).toEqual(['category', 'description', 'rules', 'impact', 'notes'])
    for (const kind of ENTITY_KINDS) {
      for (const field of ENTITY_FIELDS[kind]) expect(field.label).toMatch(/\S/)
    }
  })

  it('use each field id once per kind, and only ids of the shared list', () => {
    const seen = new Set<string>()
    for (const kind of ENTITY_KINDS) {
      const ids = fieldIdsFor(kind)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(ENTITY_FIELD_IDS).toContain(id)
        seen.add(id)
      }
    }
    // Nothing in the union that no template uses.
    expect([...ENTITY_FIELD_IDS].sort()).toEqual([...seen].sort())
  })

  it('never make `name` or `image` a field: both are columns', () => {
    expect(ENTITY_FIELD_IDS).not.toContain('name')
    expect(ENTITY_FIELD_IDS).not.toContain('image')
  })

  it('suggest world categories without making the field a list', () => {
    expect(WORLD_CATEGORY_SUGGESTIONS).toContain('Magic system')
    expect(WORLD_CATEGORY_SUGGESTIONS).toContain('Culture')
    expect(WORLD_CATEGORY_SUGGESTIONS).toContain('Technology')
    expect(ENTITY_FIELDS.world.find((f) => f.id === 'category')?.multiline).toBe(false)
  })
})

describe('isFieldOf', () => {
  it('answers for the kind that owns the field, not for any other', () => {
    expect(isFieldOf('character', 'age')).toBe(true)
    expect(isFieldOf('setting', 'age')).toBe(false)
    expect(isFieldOf('world', 'age')).toBe(false)
    expect(isFieldOf('setting', 'atmosphere')).toBe(true)
    expect(isFieldOf('world', 'atmosphere')).toBe(false)
    expect(isFieldOf('world', 'rules')).toBe(true)
    // `notes` is the one field all three share.
    for (const kind of ENTITY_KINDS) expect(isFieldOf(kind, 'notes')).toBe(true)
  })

  it('refuses an id no template knows', () => {
    expect(isFieldOf('character', 'name')).toBe(false)
    expect(isFieldOf('character', 'image')).toBe(false)
    expect(isFieldOf('character', 'favouriteColour')).toBe(false)
    expect(isFieldOf('character', '')).toBe(false)
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

describe('parseEntityFields', () => {
  it('reads the values of the kind’s own fields', () => {
    const raw = JSON.stringify({ age: '31', appearance: 'Tall, grey-eyed.' })
    expect(parseEntityFields(raw, 'character')).toEqual({
      age: '31',
      appearance: 'Tall, grey-eyed.'
    })
  })

  it('drops keys no template of the kind knows', () => {
    const raw = JSON.stringify({ age: '31', atmosphere: 'Damp', favourite: 'tea' })
    expect(parseEntityFields(raw, 'character')).toEqual({ age: '31' })
    expect(parseEntityFields(raw, 'setting')).toEqual({ atmosphere: 'Damp' })
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
    expect(parseEntityFields(raw, 'character')).toEqual({ notes: 'Keeps the key.' })
  })

  it('reads null, invalid JSON, and JSON that is not an object as nothing at all', () => {
    expect(parseEntityFields(null, 'character')).toEqual({})
    expect(parseEntityFields('', 'character')).toEqual({})
    expect(parseEntityFields('{oops', 'character')).toEqual({})
    expect(parseEntityFields('"a string"', 'character')).toEqual({})
    expect(parseEntityFields('42', 'character')).toEqual({})
    expect(parseEntityFields('null', 'character')).toEqual({})
    expect(parseEntityFields('{}', 'character')).toEqual({})
  })
})
