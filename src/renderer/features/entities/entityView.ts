import { categoryOf, type StoryCategory } from '@shared/categories'
import type { EntityTemplate } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { BIBLE_LIST_VIEWS, type BibleListView } from '@shared/storyBibleSettings'

/**
 * How an entity tab lays its rows out (F-9.2): one line each, or a card with an excerpt. F-9.17:
 * one choice for every tab, a story-bible setting (`BibleListView`).
 */
export type EntityView = BibleListView
export const ENTITY_VIEWS: readonly EntityView[] = BIBLE_LIST_VIEWS
export const ENTITY_VIEW_LABEL: Record<EntityView, string> = { list: 'List', cards: 'Cards' }

/** What the two templates are called wherever the author chooses or switches one (F-9.3). */
export const ENTITY_TEMPLATE_LABEL: Record<EntityTemplate, string> = {
  structured: 'Structured',
  blank: 'Blank page'
}

/** "In 3 scenes" / "In 1 scene" / "Not in any scene yet" (F-9.4, F-11.2c). */
export function inScenesLabel(count: number): string {
  if (count === 0) return 'Not in any scene yet'
  return count === 1 ? 'In 1 scene' : `In ${count} scenes`
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
export function excerptOf(
  entity: Pick<Entity, 'kind' | 'template' | 'fields' | 'body'>,
  categories: readonly StoryCategory[] = []
): string {
  let source = ''
  if (entity.template === 'structured') {
    for (const field of categoryOf(entity.kind, categories).fields) {
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
