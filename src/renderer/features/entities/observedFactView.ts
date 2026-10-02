import {
  ENTITY_BODY_MAX,
  ENTITY_FIELDS,
  ENTITY_FIELD_MAX,
  type EntityFieldId,
  type EntityFields
} from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { observedAttributeField, observedAttributeLabel } from '@shared/observedFacts'
import { descendantDocuments, type TreeIndex } from '@renderer/features/manuscript/treeStore'

/** How many rows the reference card shows before "+ n more" (F-5.16). */
export const OBSERVED_FACTS_COMPACT = 3

/**
 * Every document of the project in reading order (front matter, manuscript, end matter, each
 * depth-first by position): what `groupFacts` orders an entity's facts and their passages by.
 */
export function readingOrder(index: Pick<TreeIndex, 'byId' | 'childrenOf' | 'rootIds'>): string[] {
  return index.rootIds.flatMap((rootId) => descendantDocuments(index, rootId))
}

/** Where `Add to sheet` writes a fact: a field of the structured sheet, or the blank page. */
export type SheetTarget =
  { type: 'field'; field: EntityFieldId; multiline: boolean } | { type: 'body' }

/**
 * The place on the author's sheet a fact of `attribute` goes (F-5.16): the blank template has
 * one page for everything; the structured one has the attribute's own field, or nothing when
 * the kind has no such field (a row written under an older vocabulary).
 */
export function sheetTarget(
  entity: Pick<Entity, 'kind' | 'template'>,
  attribute: string
): SheetTarget | null {
  if (entity.template === 'blank') return { type: 'body' }
  const field = observedAttributeField(entity.kind, attribute)
  if (field === null) return null
  const multiline = ENTITY_FIELDS[entity.kind].find((f) => f.id === field)?.multiline ?? true
  return { type: 'field', field, multiline }
}

/** Lower-cased, whitespace collapsed, closing punctuation dropped: how sheet text and a value compare. */
const fold = (text: string): string =>
  text
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?,;:\s]+$/u, '')
    .toLocaleLowerCase()

/** Whether the sheet text already says `value`, however it is cased or spaced. */
export function isOnSheet(text: string, value: string): boolean {
  const needle = fold(value)
  return needle !== '' && fold(text).includes(needle)
}

/** The sheet as the page shows it: the open draft's text when there is one, else the stored row. */
export interface SheetText {
  fields: EntityFields
  body: string
}

/** The text of the place a fact would go, as it stands. */
export function sheetTextAt(sheet: SheetText, target: SheetTarget): string {
  return target.type === 'body' ? sheet.body : (sheet.fields[target.field] ?? '')
}

/**
 * The target's text with the fact added (F-5.16): the value on a new line of a field (after
 * `; ` in a one-line field, which cannot hold a line break), or `Label: value` on a new line of
 * the blank page, where a bare value would not say what it is about. Null when the result would
 * not fit the column.
 */
export function withFactAdded(
  entity: Pick<Entity, 'kind'>,
  sheet: SheetText,
  target: SheetTarget,
  attribute: string,
  value: string
): string | null {
  const current = sheetTextAt(sheet, target).replace(/\s+$/u, '')
  const addition =
    target.type === 'body' ? `${observedAttributeLabel(entity.kind, attribute)}: ${value}` : value
  const separator = target.type === 'field' && !target.multiline ? '; ' : '\n'
  const next = current === '' ? addition : `${current}${separator}${addition}`
  const max = target.type === 'body' ? ENTITY_BODY_MAX : ENTITY_FIELD_MAX
  return next.length > max ? null : next
}
