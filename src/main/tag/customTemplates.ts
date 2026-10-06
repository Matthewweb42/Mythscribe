import { randomUUID } from 'node:crypto'
import {
  CUSTOM_TAG_TEMPLATES_MAX,
  CUSTOM_TAG_TEMPLATE_TAGS_MAX,
  type CustomTagTemplate,
  customTemplateNameKey,
  keepTemplateRecords
} from '@shared/tagTemplates'
import type { TagExchangeRecord } from '@shared/tagExchange'
import { AppError } from '../ipc/errors'

/**
 * Custom tag templates (F-4.11): pure edits of the app-state list. The handlers own reading and
 * writing app state; these own the rules (unique names, the caps, at least one tag) so they are
 * tested without a file. Every function answers the next list and the template it touched.
 */

type Templates = readonly CustomTagTemplate[]

function assertNameFree(templates: Templates, name: string, exceptId?: string): void {
  const key = customTemplateNameKey(name)
  const clash = templates.find((t) => t.id !== exceptId && customTemplateNameKey(t.name) === key)
  if (clash) {
    throw new AppError('ALREADY_EXISTS', `A template named "${clash.name}" already exists`, {
      name
    })
  }
}

function assertTags(records: readonly TagExchangeRecord[]): void {
  if (records.length === 0) throw new AppError('VALIDATION', 'A template needs at least one tag')
  if (records.length > CUSTOM_TAG_TEMPLATE_TAGS_MAX) {
    throw new AppError(
      'VALIDATION',
      `A template holds at most ${CUSTOM_TAG_TEMPLATE_TAGS_MAX.toLocaleString('en-US')} tags`
    )
  }
}

function find(templates: Templates, id: string): CustomTagTemplate {
  const template = templates.find((t) => t.id === id)
  if (!template) throw new AppError('NOT_FOUND', 'Tag template not found', { id })
  return template
}

/** Sorted by name key, so every list the author sees has one order. */
function sorted(templates: CustomTagTemplate[]): CustomTagTemplate[] {
  return templates.sort((a, b) =>
    customTemplateNameKey(a.name).localeCompare(customTemplateNameKey(b.name))
  )
}

export function addCustomTemplate(
  templates: Templates,
  name: string,
  records: readonly TagExchangeRecord[],
  now: Date = new Date()
): { templates: CustomTagTemplate[]; template: CustomTagTemplate } {
  const trimmed = name.trim()
  assertNameFree(templates, trimmed)
  assertTags(records)
  if (templates.length >= CUSTOM_TAG_TEMPLATES_MAX) {
    throw new AppError(
      'VALIDATION',
      `You can keep up to ${CUSTOM_TAG_TEMPLATES_MAX} templates; delete one to save another`
    )
  }
  const stamp = now.toISOString()
  const template: CustomTagTemplate = {
    id: randomUUID(),
    name: trimmed,
    tags: [...records],
    created: stamp,
    modified: stamp
  }
  return { templates: sorted([...templates, template]), template }
}

/**
 * Renames a template and/or keeps only the named tags (the edit dialog removes tags; it never
 * adds them, since saving again from a bank is how tags are added). Removing every tag is refused:
 * delete the template instead.
 */
export function updateCustomTemplate(
  templates: Templates,
  id: string,
  patch: { name?: string; keep?: readonly string[] },
  now: Date = new Date()
): { templates: CustomTagTemplate[]; template: CustomTagTemplate } {
  const existing = find(templates, id)
  const name = patch.name === undefined ? existing.name : patch.name.trim()
  if (patch.name !== undefined) assertNameFree(templates, name, id)
  const tags =
    patch.keep === undefined
      ? existing.tags
      : keepTemplateRecords(existing.tags, new Set(patch.keep))
  assertTags(tags)
  const template: CustomTagTemplate = { ...existing, name, tags, modified: now.toISOString() }
  return {
    templates: sorted(templates.map((t) => (t.id === id ? template : t))),
    template
  }
}

export function removeCustomTemplate(templates: Templates, id: string): CustomTagTemplate[] {
  find(templates, id)
  return templates.filter((t) => t.id !== id)
}
