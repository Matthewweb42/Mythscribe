import { describe, expect, it } from 'vitest'
import type { TagExchangeRecord } from '@shared/tagExchange'
import {
  CUSTOM_TAG_TEMPLATES_MAX,
  CUSTOM_TAG_TEMPLATE_TAGS_MAX,
  keepTemplateRecords
} from '@shared/tagTemplates'
import { addCustomTemplate, removeCustomTemplate, updateCustomTemplate } from './customTemplates'

const record = (name: string, parent: string | null = null): TagExchangeRecord => ({
  name,
  category: 'character',
  color: '#aa0000',
  parent,
  trackMentions: true
})

const RECORDS = [record('mara'), record('tomas'), record('mara-young', 'mara')]
const NOW = new Date('2026-10-06T10:00:00.000Z')
const LATER = new Date('2026-10-07T10:00:00.000Z')

describe('custom tag templates (F-4.11)', () => {
  it('adds a template with a trimmed name and stamps it, keeping the list sorted by name', () => {
    const first = addCustomTemplate([], '  Village saga ', RECORDS, NOW)
    expect(first.template).toMatchObject({
      name: 'Village saga',
      tags: RECORDS,
      created: NOW.toISOString(),
      modified: NOW.toISOString()
    })
    const second = addCustomTemplate(first.templates, 'abbey', [record('ilse')], NOW)
    expect(second.templates.map((t) => t.name)).toEqual(['abbey', 'Village saga'])
  })

  it('refuses a taken name ignoring case and spacing, an empty bank, and a full list', () => {
    const { templates } = addCustomTemplate([], 'Village saga', RECORDS, NOW)
    expect(() => addCustomTemplate(templates, 'village   SAGA', RECORDS)).toThrowError(
      /already exists/
    )
    expect(() => addCustomTemplate(templates, 'Empty', [])).toThrowError(/at least one tag/)
    const many = Array.from({ length: CUSTOM_TAG_TEMPLATE_TAGS_MAX + 1 }, (_, index) =>
      record(`t-${index}`)
    )
    expect(() => addCustomTemplate(templates, 'Huge', many)).toThrowError(/at most/)
    let full = templates
    for (let index = 1; index < CUSTOM_TAG_TEMPLATES_MAX; index++) {
      full = addCustomTemplate(full, `T ${index}`, RECORDS).templates
    }
    expect(() => addCustomTemplate(full, 'One more', RECORDS)).toThrowError(/up to 50/)
  })

  it('renames and trims tags, dropping a parent the template no longer carries', () => {
    const { templates, template } = addCustomTemplate([], 'Village saga', RECORDS, NOW)
    const renamed = updateCustomTemplate(templates, template.id, { name: 'Village' }, LATER)
    expect(renamed.template).toMatchObject({
      name: 'Village',
      created: NOW.toISOString(),
      modified: LATER.toISOString()
    })
    const trimmed = updateCustomTemplate(templates, template.id, { keep: ['mara-young', 'tomas'] })
    expect(trimmed.template.tags).toEqual([record('tomas'), record('mara-young')])
  })

  it('refuses keeping no tags, a taken name, and an unknown id; renaming to itself is fine', () => {
    let { templates, template } = addCustomTemplate([], 'Village saga', RECORDS, NOW)
    templates = addCustomTemplate(templates, 'Abbey', RECORDS, NOW).templates
    expect(() => updateCustomTemplate(templates, template.id, { keep: [] })).toThrowError(
      /at least one tag/
    )
    expect(() => updateCustomTemplate(templates, template.id, { name: 'abbey' })).toThrowError(
      /already exists/
    )
    expect(() => updateCustomTemplate(templates, 'nope', { name: 'X' })).toThrowError(/not found/)
    expect(
      updateCustomTemplate(templates, template.id, { name: 'village saga' }).template.name
    ).toBe('village saga')
    template = templates[1]!
    expect(removeCustomTemplate(templates, template.id).map((t) => t.name)).toEqual(['Abbey'])
    expect(() => removeCustomTemplate(templates, 'nope')).toThrowError(/not found/)
  })

  it('keeps the named records in their order and nulls a parent outside them', () => {
    expect(keepTemplateRecords(RECORDS, new Set(['mara-young', 'mara']))).toEqual([
      record('mara'),
      record('mara-young', 'mara')
    ])
    expect(keepTemplateRecords(RECORDS, new Set(['mara-young']))).toEqual([record('mara-young')])
  })
})
