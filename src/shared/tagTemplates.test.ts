import { describe, expect, it } from 'vitest'
import { TAG_CATEGORIES, TagCategory, toTagName } from '@shared/tags'
import { TAG_TEMPLATE_IDS, TAG_TEMPLATES, TagTemplateId, tagTemplateById } from './tagTemplates'

const NON_CUSTOM = TAG_CATEGORIES.filter((c) => c !== 'custom')

describe('tag templates (F-4.3)', () => {
  it('ships the four templates in id order with non-empty labels', () => {
    expect(TAG_TEMPLATES.map((t) => t.id)).toEqual([...TAG_TEMPLATE_IDS])
    expect(TAG_TEMPLATES.map((t) => t.label)).toEqual([
      'Standard Fiction',
      'Mystery',
      'Fantasy',
      'Sci-Fi'
    ])
    for (const id of TAG_TEMPLATE_IDS) {
      expect(TagTemplateId.parse(id)).toBe(id)
      expect(tagTemplateById(id)?.id).toBe(id)
    }
  })

  it.each(TAG_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s covers every non-custom category with 4 to 8 tags each',
    (_id, template) => {
      for (const category of NON_CUSTOM) {
        const count = template.tags.filter((tag) => tag.category === category).length
        expect(count, category).toBeGreaterThanOrEqual(4)
        expect(count, category).toBeLessThanOrEqual(8)
      }
      for (const tag of template.tags) {
        expect(TagCategory.parse(tag.category)).not.toBe('custom')
      }
    }
  )

  it.each(TAG_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s uses kebab-case names that are unique within the template',
    (_id, template) => {
      const names = template.tags.map((tag) => tag.name)
      for (const name of names) {
        expect(name.length).toBeGreaterThan(0)
        expect(toTagName(name)).toBe(name)
      }
      expect(new Set(names).size).toBe(names.length)
    }
  )
})
