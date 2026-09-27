import { ENTITY_FIELDS, type EntityKind, type EntityTemplate } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import type { SidebarTabId } from '@shared/sidebarTabs'

/** How an entity tab lays its rows out (F-9.2): one line each, or a card with an excerpt. */
export type EntityView = 'list' | 'cards'
export const ENTITY_VIEWS: readonly EntityView[] = ['list', 'cards']
export const ENTITY_VIEW_LABEL: Record<EntityView, string> = { list: 'List', cards: 'Cards' }

/** The sidebar tab each kind lives on (F-9.2), so a new entity is shown where its list is. */
export const ENTITY_KIND_TAB: Record<EntityKind, SidebarTabId> = {
  character: 'characters',
  setting: 'settings',
  world: 'world'
}

/** What the two templates are called wherever the author chooses or switches one (F-9.3). */
export const ENTITY_TEMPLATE_LABEL: Record<EntityTemplate, string> = {
  structured: 'Structured',
  blank: 'Blank page'
}

/** Longest excerpt a card shows, in characters. */
export const EXCERPT_MAX = 120

/** The world category filter of the World tab: every category in use, or all of them. */
export const ALL_CATEGORIES = 'all'

/**
 * Whether the entity matches a search: its name, every stored field, and the blank page are
 * searched, case-insensitively. `needle` is already trimmed and lower-cased; an empty needle
 * matches everything.
 */
export function matchesQuery(entity: Entity, needle: string): boolean {
  if (needle.length === 0) return true
  if (entity.name.toLowerCase().includes(needle)) return true
  for (const value of Object.values(entity.fields)) {
    if (value?.toLowerCase().includes(needle)) return true
  }
  return entity.body?.toLowerCase().includes(needle) ?? false
}

/**
 * One line summarizing the entity for its card: the first filled field of the kind's template,
 * in template order, or the blank page, whitespace collapsed and cut at `EXCERPT_MAX`. The World
 * category is skipped because the card shows it as a chip. Empty when nothing is written yet.
 * Takes only what it reads, so an entity that is not stored yet — an incoming import row (F-9.5)
 * — gets the same line as a card.
 */
export function excerptOf(entity: Pick<Entity, 'kind' | 'template' | 'fields' | 'body'>): string {
  let source = ''
  if (entity.template === 'structured') {
    for (const field of ENTITY_FIELDS[entity.kind]) {
      if (field.id === 'category') continue
      const value = entity.fields[field.id]
      if (value !== undefined && value.trim().length > 0) {
        source = value
        break
      }
    }
  }
  if (source.length === 0 && entity.body !== null) source = entity.body
  const line = source.replace(/\s+/g, ' ').trim()
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : line
}

/** The distinct world categories in use, in first-seen order (the World tab's filter strip). */
export function categoriesOf(entities: readonly Entity[]): string[] {
  const seen: string[] = []
  for (const entity of entities) {
    const category = entity.fields.category?.trim()
    if (category !== undefined && category.length > 0 && !seen.includes(category)) {
      seen.push(category)
    }
  }
  return seen
}
