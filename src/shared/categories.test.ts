import { describe, expect, it } from 'vitest'
import {
  ALWAYS_SHOWN_CATEGORIES,
  BUILTIN_CATEGORIES,
  BUILTIN_CATEGORY_IDS,
  CUSTOM_CATEGORY_PREFIX,
  StoryCategory,
  builtinCategory,
  categoryFieldIds,
  categoryFieldLabel,
  categoryFromInput,
  categoryOf,
  compareCategoryIds,
  countNoun,
  customCategoryId,
  fieldIdFromLabel,
  isCategoryField,
  isKnownCategory,
  mergeCategories,
  singularOf
} from './categories'
import { EntityFieldId, EntityKind } from './entities'
import { TAG_CATEGORIES } from './tags'

const field = (id: string) => (c: StoryCategory) => isCategoryField(c, id)

describe('the library (F-9.11)', () => {
  it('opens with the three F-9.1 kinds under their old ids, Settings now called Places', () => {
    expect(BUILTIN_CATEGORY_IDS.slice(0, 3)).toEqual(['character', 'setting', 'world'])
    expect(builtinCategory('setting')?.name).toBe('Places')
    expect(builtinCategory('character')?.name).toBe('Characters')
    expect(ALWAYS_SHOWN_CATEGORIES).toEqual(['character', 'setting'])
  })

  it('keeps the F-9.1 templates field for field', () => {
    const ids = (id: string): string[] => categoryFieldIds(categoryOf(id))
    expect(ids('character')).toEqual([
      'age',
      'born',
      'gender',
      'appearance',
      'personality',
      'background',
      'goals',
      'relationships',
      'notes'
    ])
    expect(ids('setting')).toEqual([
      'type',
      'description',
      'atmosphere',
      'features',
      'associatedCharacters',
      'notes'
    ])
    expect(ids('world')).toEqual(['category', 'description', 'rules', 'impact', 'notes'])
  })

  it('has the categories the author asked for, each valid, with fields ending in Notes', () => {
    for (const id of [
      'magic',
      'faction',
      'religion',
      'creature',
      'item',
      'culture',
      'history',
      'language',
      'technology'
    ]) {
      expect(BUILTIN_CATEGORY_IDS).toContain(id)
    }
    for (const category of BUILTIN_CATEGORIES) {
      expect(StoryCategory.safeParse(category).success).toBe(true)
      expect(EntityKind.safeParse(category.id).success).toBe(true)
      expect(category.fields.at(-1)?.id).toBe('notes')
      const fieldIds = categoryFieldIds(category)
      expect(new Set(fieldIds).size).toBe(fieldIds.length)
      for (const id of fieldIds) expect(EntityFieldId.safeParse(id).success).toBe(true)
      expect(fieldIds).not.toContain('name')
      expect(TAG_CATEGORIES).toContain(category.tagCategory)
      expect(category.hint).toMatch(/\S/)
    }
    expect(new Set(BUILTIN_CATEGORY_IDS).size).toBe(BUILTIN_CATEGORY_IDS.length)
  })

  it('carries pictures for characters, places, creatures, and items only', () => {
    expect(BUILTIN_CATEGORIES.filter((c) => c.hasImage).map((c) => c.id)).toEqual([
      'character',
      'setting',
      'creature',
      'item'
    ])
  })

  it('tags characters and places under their own tag categories, the rest as world building', () => {
    expect(categoryOf('character').tagCategory).toBe('character')
    expect(categoryOf('setting').tagCategory).toBe('setting')
    expect(categoryOf('magic').tagCategory).toBe('worldBuilding')
  })

  it('answers fields per category', () => {
    expect(field('age')(categoryOf('character'))).toBe(true)
    expect(field('age')(categoryOf('setting'))).toBe(false)
    expect(field('costs')(categoryOf('magic'))).toBe(true)
    expect(categoryFieldLabel(categoryOf('magic'), 'costs')).toBe('Costs and limits')
    expect(categoryFieldLabel(categoryOf('magic'), 'nope')).toBe('nope')
  })
})

describe('categoryOf', () => {
  it('prefers the project list, then the library, then a generic category', () => {
    const renamed = { ...categoryOf('setting'), name: 'Locations' }
    expect(categoryOf('setting', [renamed]).name).toBe('Locations')
    expect(categoryOf('setting').name).toBe('Places')
    const unknown = categoryOf('c-gone')
    expect(unknown.name).toBe('c-gone')
    expect(categoryFieldIds(unknown)).toEqual(['description', 'notes'])
    expect(isKnownCategory('c-gone', [])).toBe(false)
    expect(isKnownCategory('magic', [])).toBe(true)
  })
})

describe('project categories', () => {
  it('mint ids from the name, prefixed and unique', () => {
    expect(customCategoryId('Ships', [])).toBe(`${CUSTOM_CATEGORY_PREFIX}ships`)
    expect(customCategoryId('Ships', ['c-ships'])).toBe('c-ships-2')
    expect(customCategoryId('Écoles de magie!', [])).toBe('c-ecoles-de-magie')
    expect(customCategoryId('???', [])).toBe('c-category')
  })

  it('mint camel-case field ids from labels', () => {
    expect(fieldIdFromLabel('Home port', [])).toBe('homePort')
    expect(fieldIdFromLabel('Home port', ['homePort'])).toBe('homePort2')
    expect(fieldIdFromLabel('42 guns', [])).toBe('guns')
    expect(fieldIdFromLabel('!!', [])).toBe('field')
  })

  it('build a template from labels, Notes last, duplicates and Notes dropped', () => {
    const category = categoryFromInput(
      'c-ships',
      { name: 'Ships', fields: ['Crew', 'Home port', 'crew', 'Notes'] },
      'ai'
    )
    expect(category.fields).toEqual([
      { id: 'crew', label: 'Crew', multiline: true },
      { id: 'homePort', label: 'Home port', multiline: true },
      { id: 'notes', label: 'Notes', multiline: true }
    ])
    expect(category.noun).toBe('ship')
    expect(category.icon).toBe('folder')
    expect(category.builtIn).toBe(false)
    expect(category.origin).toBe('ai')
    expect(StoryCategory.safeParse(category).success).toBe(true)
  })

  it('sort after the library, and the library in its order', () => {
    const ids = ['c-ships', 'world', 'character', 'magic', 'c-art']
    expect([...ids].sort(compareCategoryIds)).toEqual([
      'character',
      'world',
      'magic',
      'c-art',
      'c-ships'
    ])
  })

  it('merge after the library, a rename replacing only name, singular, and icon', () => {
    const ships = categoryFromInput('c-ships', { name: 'Ships', fields: [] }, 'author')
    const merged = mergeCategories(
      new Map([['setting', { name: 'Locations', noun: 'location', icon: 'castle' as const }]]),
      [ships]
    )
    expect(merged.at(-1)).toBe(ships)
    const setting = merged.find((c) => c.id === 'setting')
    expect(setting?.name).toBe('Locations')
    expect(setting?.fields).toBe(builtinCategory('setting')?.fields)
  })
})

describe('words', () => {
  it.each([
    ['Ships', 'ship'],
    ['Factions', 'faction'],
    ['Histories', 'history'],
    ['Churches', 'church'],
    ['Glass', 'glass'],
    ['Lore', 'lore']
  ])('singularOf %j → %j', (input, expected) => {
    expect(singularOf(input)).toBe(expected)
  })

  it('counts with the right plural', () => {
    expect(countNoun(1, { noun: 'magic system' })).toBe('1 magic system')
    expect(countNoun(3, { noun: 'magic system' })).toBe('3 magic systems')
    expect(countNoun(2, { noun: 'history' })).toBe('2 histories')
    expect(countNoun(2, { noun: 'church' })).toBe('2 churches')
  })
})
