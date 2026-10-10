import { createHash } from 'node:crypto'
import { z } from 'zod'
import { categoryOf, type StoryCategory } from '@shared/categories'
import type { EntityFieldDef, EntityFields } from '@shared/entities'
import {
  NO_SHEET_SYNC,
  SheetExtraFields,
  paragraphKey,
  paragraphsOf,
  sheetFieldDefs,
  type SheetSyncState,
  type SheetSyncView
} from '@shared/sheetSync'
import {
  writeUpRoleOf,
  writeUpStyleOf,
  type StoryBibleSettings,
  type WriteUpStyle
} from '@shared/storyBibleSettings'
import { getStoryBibleSettings } from '../project/settingsStore'
import { listCategories } from './categoryStore'
import type { EntityDb } from './entityStore'

/**
 * Where a sheet's two views stand (F-9.18), main only: the stored `entity.sync` column, the hashes
 * it is compared by, and the view the contract's `Entity.sync` carries. No AI here: the requests
 * are `src/main/ai/sheetSync.ts`. Pure over its inputs, so the entity store can answer every row
 * with its state and the sync can tell, without asking anything, that there is nothing to do.
 */

/** The `entity.sync` column. */
export const StoredSheetSync = z.object({
  /** The fields hash (`fieldsHashOf`) the two views last agreed on; '' marks the page out of date on purpose. */
  fieldsHash: z.string(),
  /** The page as it was when the views last agreed: what a filing diffs the page against. */
  page: z.string(),
  /** Hashes (`paragraphHash`) of the paragraphs the AI wrote in the page. */
  aiParagraphs: z.array(z.string()).default([]),
  /** When the AI last wrote the page up; null when it never did. */
  writtenUpAt: z.string().nullable().default(null),
  /**
   * The page as it was just before the last write-up landed: what an author's page edit made from
   * a draft older than that write-up was edited from (`staleWriteUpBase`).
   */
  pageBefore: z.string().nullable().default(null),
  at: z.string()
})
export type StoredSheetSync = z.infer<typeof StoredSheetSync>

/** The stored column, leniently: null, bad JSON, or a shape this build does not know reads as never synced. */
export function parseStoredSheetSync(raw: string | null): StoredSheetSync | null {
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = StoredSheetSync.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** The stored `entity.extra_fields` column, leniently: anything unreadable is no field of its own. */
export function parseExtraFields(raw: string | null): EntityFieldDef[] {
  if (raw === null) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = SheetExtraFields.safeParse(json)
  return parsed.success ? parsed.data : []
}

/** A short content hash (64 bits of SHA-256, hex): enough to tell two texts apart. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** The hash a paragraph is remembered by as AI-written: whitespace runs do not count. */
export function paragraphHash(paragraph: string): string {
  return hashText(paragraphKey(paragraph))
}

/** A page as two pages are compared: its paragraphs, whitespace runs collapsed. */
export function pageKey(page: string | null | undefined): string {
  return paragraphsOf(page).map(paragraphKey).join('\n\n')
}

/**
 * What the page is written up from: every field of the sheet in order (label and value) and the
 * category's write-up style. A field added in Structured, a renamed label, a reordered template,
 * or a new style all move it, so the page reads as out of date until it is written up again.
 */
export function fieldsHashOf(
  defs: readonly EntityFieldDef[],
  values: EntityFields,
  style: WriteUpStyle
): string {
  return hashText(
    JSON.stringify({
      f: defs.map((field) => [field.id, field.label, (values[field.id] ?? '').trim()]),
      s: [style.length, defs.map((field) => writeUpRoleOf(style, field))]
    })
  )
}

/** What a read of the story bible needs to tell every sheet's state: the categories and the style. */
export interface SheetSyncContext {
  categories: readonly StoryCategory[]
  settings: StoryBibleSettings
}

export function sheetSyncContext(db: EntityDb): SheetSyncContext {
  return { categories: listCategories(db), settings: getStoryBibleSettings(db) }
}

/** The parts of a sheet its state is read from. */
export interface SheetParts {
  kind: string
  fields: EntityFields
  extraFields: readonly EntityFieldDef[]
  body: string | null
}

/** A sheet as a sync sees it: its category, every field in order, the style, and the hashes. */
export interface SheetBasis {
  category: StoryCategory
  defs: EntityFieldDef[]
  style: WriteUpStyle
  fieldsHash: string
  page: string
  /** Whether any field of the sheet has text. */
  fieldsFilled: boolean
  pageFilled: boolean
}

export function sheetBasis(sheet: SheetParts, ctx: SheetSyncContext): SheetBasis {
  const category = categoryOf(sheet.kind, ctx.categories)
  const defs = sheetFieldDefs(category, sheet.extraFields)
  const style = writeUpStyleOf(ctx.settings, category.id)
  const page = sheet.body ?? ''
  return {
    category,
    defs,
    style,
    fieldsHash: fieldsHashOf(defs, sheet.fields, style),
    page,
    fieldsFilled: defs.some((field) => (sheet.fields[field.id] ?? '').trim() !== ''),
    pageFilled: paragraphsOf(page).length > 0
  }
}

/**
 * Where the two views stand. Never synced: fields with text make the page out of date, a page
 * with text makes the fields out of date (an existing Blank page sheet: its page is the source,
 * and its fields are filled from it at the next sync). Synced before: whichever side moved since.
 */
export function sheetSyncStateOf(
  basis: SheetBasis,
  stored: StoredSheetSync | null
): SheetSyncState {
  const fieldsMoved = stored === null ? basis.fieldsFilled : basis.fieldsHash !== stored.fieldsHash
  const pageMoved =
    stored === null ? basis.pageFilled : pageKey(basis.page) !== pageKey(stored.page)
  if (fieldsMoved && pageMoved) return 'both'
  if (fieldsMoved) return 'pageStale'
  if (pageMoved) return 'fieldsStale'
  return stored === null ? 'none' : 'synced'
}

/** The contract's `Entity.sync` for a sheet. */
export function sheetSyncViewOf(
  sheet: SheetParts,
  rawSync: string | null,
  ctx: SheetSyncContext
): SheetSyncView {
  const stored = parseStoredSheetSync(rawSync)
  const basis = sheetBasis(sheet, ctx)
  const state = sheetSyncStateOf(basis, stored)
  const paragraphs = paragraphsOf(basis.page)
  const ai = new Set(stored?.aiParagraphs ?? [])
  const aiParagraphs = paragraphs.filter((paragraph) => ai.has(paragraphHash(paragraph))).length
  if (stored === null && state === 'none')
    return { ...NO_SHEET_SYNC, paragraphs: paragraphs.length }
  return {
    state,
    aiParagraphs,
    paragraphs: paragraphs.length,
    writtenUpAt: stored?.writtenUpAt ?? null
  }
}
