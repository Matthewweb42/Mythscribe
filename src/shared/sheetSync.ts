import { z } from 'zod'
import {
  CategoryFieldDef,
  categoryFieldLabel,
  fieldIdFromLabel,
  joinSheetText,
  type StoryCategory
} from './categories'
import type { EntityFieldDef } from './entities'
import { JobFailure } from './jobs'
import { writeUpRoleOf, type WriteUpLength, type WriteUpStyle } from './storyBibleSettings'

/**
 * Two views of every story-bible sheet, kept true to each other (F-9.18; requested by the author
 * 2026-10-10). Structured is the category's fields (plus the sheet's own, `extraFields`); the
 * Blank page is one flowing document the AI writes up from them. Edit the fields and the page is
 * written up again; edit the page and the AI files the edits back into the fields. Background and
 * cheap: only after the author has left the sheet alone for `SHEET_SYNC_DELAY_MS`, fast tier,
 * nothing sent while the hashes say both views already agree, cached by context. This file owns
 * the vocabulary both sides share and the pure text rules; main owns the hashes, the stored
 * state, and the requests (`src/main/entity/sheetSync.ts`).
 */

/**
 * Settings-table key of the sheets whose pause is over and whose sync waits its turn (a JSON list
 * of entity ids), so a quit or a crash resumes them with the project.
 */
export const SHEET_SYNC_DUE_KEY = 'sheetSyncDue'
/** At most this many sheets wait in the due list; older ones drop off (they still show out of date). */
export const SHEET_SYNC_DUE_MAX = 200

/** How long a sheet must be left alone before its views are made true to each other. */
export const SHEET_SYNC_DELAY_MS = 30_000
/** Most fields a sheet may add of its own, beside its category's template. */
export const SHEET_EXTRA_FIELDS_MAX = 12
/** The added page text one filing request carries; a longer edit is filed in several requests. */
export const REFILE_CHUNK_CHARS = 3_000
/** The output cap of a filing request (compact edits, never whole field values). */
export const REFILE_MAX_TOKENS = 900
/** The output cap of a write-up by length (the JSON wrapping included). */
export const WRITE_UP_MAX_TOKENS: Readonly<Record<WriteUpLength, number>> = {
  short: 400,
  medium: 700,
  long: 1_200
}

/**
 * Where a sheet's two views stand. `synced`: they agree. `pageStale`: the fields moved since the
 * page was written up. `fieldsStale`: the page was edited since the fields were filed. `both`:
 * both moved (the page is filed first, then written up again). `none`: there is nothing on either
 * side.
 */
export const SHEET_SYNC_STATES = ['none', 'synced', 'pageStale', 'fieldsStale', 'both'] as const
export const SheetSyncState = z.enum(SHEET_SYNC_STATES)
export type SheetSyncState = z.infer<typeof SheetSyncState>

/** Which view a sync rewrites: the page (a write-up) or the fields (a filing). */
export const SheetSyncDirection = z.enum(['page', 'fields'])
export type SheetSyncDirection = z.infer<typeof SheetSyncDirection>

/** One field a held filing would change, as the sheet shows it before Apply. */
export const SheetSyncChange = z.object({
  fieldId: z.string(),
  label: z.string(),
  before: z.string(),
  after: z.string()
})
export type SheetSyncChange = z.infer<typeof SheetSyncChange>

/**
 * A sync held for the author (chat mode Ask or Plan): the new page, or the field changes, shown
 * with Apply and Dismiss. Nothing of it is in the sheet until Apply.
 */
export const SheetSyncPendingView = z.object({
  direction: SheetSyncDirection,
  at: z.string(),
  /** The page a held write-up would put in place; null for a filing. */
  page: z.string().nullable(),
  /** The fields a held filing would change; empty for a write-up. */
  changes: z.array(SheetSyncChange)
})
export type SheetSyncPendingView = z.infer<typeof SheetSyncPendingView>

/** What the sheet page shows about its two views (`Entity.sync`), computed by main on every read. */
export const SheetSyncView = z.object({
  state: SheetSyncState,
  /** Paragraphs of the page as it stands that the AI wrote (provenance, AI rule 1). */
  aiParagraphs: z.number().int().nonnegative(),
  /** Paragraphs of the page as it stands. */
  paragraphs: z.number().int().nonnegative(),
  /** When the page was last written up by the AI; null when it never was. */
  writtenUpAt: z.string().nullable(),
  pending: SheetSyncPendingView.nullable()
})
export type SheetSyncView = z.infer<typeof SheetSyncView>

export const NO_SHEET_SYNC: SheetSyncView = {
  state: 'none',
  aiParagraphs: 0,
  paragraphs: 0,
  writtenUpAt: null,
  pending: null
}

/** A sheet's own fields as stored and sent: the category's field shape. */
export const SheetExtraFields = z.array(CategoryFieldDef).max(SHEET_EXTRA_FIELDS_MAX)

/** Where a sheet's sync is in main's queue: waiting out the pause, running, or failed with its cause. */
export const SheetSyncPhase = z.enum(['waiting', 'running', 'failed'])
export type SheetSyncPhase = z.infer<typeof SheetSyncPhase>

export const SheetSyncStatus = z.object({
  entityId: z.string(),
  phase: SheetSyncPhase,
  failure: JobFailure.nullable()
})
export type SheetSyncStatus = z.infer<typeof SheetSyncStatus>

/** The fields of one sheet, in page order: its category's template, then its own. */
export function sheetFieldDefs(
  category: StoryCategory,
  extra: readonly EntityFieldDef[]
): EntityFieldDef[] {
  const ids = new Set(category.fields.map((field) => field.id))
  return [...category.fields, ...extra.filter((field) => !ids.has(field.id))]
}

/** The label of a field of a sheet: its category's, its own, or the raw id. */
export function sheetFieldLabel(
  category: StoryCategory,
  extra: readonly EntityFieldDef[],
  id: string
): string {
  return extra.find((field) => field.id === id)?.label ?? categoryFieldLabel(category, id)
}

/** A page's paragraphs: split on blank lines, trimmed, empty ones dropped. */
export function paragraphsOf(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
}

/** A paragraph as two pages are compared: whitespace runs collapsed. */
export function paragraphKey(paragraph: string): string {
  return paragraph.replace(/\s+/g, ' ').trim()
}

/**
 * What the author changed on the page since `before`: the paragraphs no longer there and the new
 * ones, in page order, compared by `paragraphKey` as a multiset (a paragraph moved elsewhere is
 * no edit; one written twice counts twice).
 */
export function pageEdits(
  before: string | null | undefined,
  after: string | null | undefined
): { removed: string[]; added: string[] } {
  const was = paragraphsOf(before)
  const now = paragraphsOf(after)
  const left = new Map<string, number>()
  for (const paragraph of was) {
    const key = paragraphKey(paragraph)
    left.set(key, (left.get(key) ?? 0) + 1)
  }
  const added: string[] = []
  for (const paragraph of now) {
    const key = paragraphKey(paragraph)
    const count = left.get(key) ?? 0
    if (count > 0) left.set(key, count - 1)
    else added.push(paragraph)
  }
  const removed: string[] = []
  for (const paragraph of was) {
    const key = paragraphKey(paragraph)
    const count = left.get(key) ?? 0
    if (count > 0) {
      removed.push(paragraph)
      left.set(key, count - 1)
    }
  }
  return { removed, added }
}

/** Groups paragraphs into chunks of at most `max` characters (one longer paragraph is its own chunk). */
export function chunkParagraphs(paragraphs: readonly string[], max: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const paragraph of paragraphs) {
    if (current.length > 0 && size + paragraph.length > max) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(paragraph)
    size += paragraph.length + 2
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** What a write-up answer holds: the opening paragraphs, and one text per heading field. */
export interface WriteUpAnswer {
  intro: string
  parts: Readonly<Record<string, string>>
}

/**
 * The page a write-up lays out, deterministically: the opening paragraphs first, then each
 * heading field that has text in field order, its label on a line of its own above its
 * paragraphs. The model writes the prose; the layout, the headings, and the order are the
 * author's style, never the model's.
 */
export function layoutWriteUp(
  fields: readonly EntityFieldDef[],
  style: WriteUpStyle,
  answer: WriteUpAnswer
): string {
  const blocks: string[] = []
  const intro = answer.intro.trim()
  if (intro !== '') blocks.push(intro)
  for (const field of fields) {
    if (writeUpRoleOf(style, field) !== 'heading') continue
    const text = (answer.parts[field.id] ?? '').trim()
    if (text !== '') blocks.push(`${field.label}\n${text}`)
  }
  return blocks.join('\n\n')
}

/** One filing edit: in field `f`, `old` (copied from its value; empty to add) becomes `new` (empty to remove). */
export interface RefileEdit {
  f: string
  old: string
  new: string
}

/** Something the page said that no field holds: a field of the sheet's own. */
export interface RefileAdd {
  label: string
  value: string
}

/** Tidies a field after an edit: no run of blank lines, no doubled spaces, trimmed. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Applies a filing to a sheet's values, locally (F-9.18): an edit whose `old` is found replaces
 * it (its first occurrence); one whose `old` is empty or not found adds `new` under the field's
 * text (`joinSheetText`, so text the field already holds is not doubled); an edit of a field the
 * sheet does not have is dropped. Each `add` becomes a field of the sheet's own, unless its label
 * names a field the sheet has (then its value is added there). Answers the values (every field,
 * '' for an emptied one) and the sheet's own fields, new ones appended.
 */
export function applyRefile(
  fields: readonly EntityFieldDef[],
  extra: readonly EntityFieldDef[],
  values: Readonly<Partial<Record<string, string>>>,
  edits: readonly RefileEdit[],
  adds: readonly RefileAdd[]
): { values: Record<string, string>; extra: EntityFieldDef[] } {
  const next: Record<string, string> = {}
  for (const [id, value] of Object.entries(values)) if (value !== undefined) next[id] = value
  const known = new Set(fields.map((field) => field.id))
  for (const edit of edits) {
    if (!known.has(edit.f)) continue
    const current = next[edit.f] ?? ''
    const old = edit.old.trim()
    if (old !== '' && current.includes(old)) {
      next[edit.f] = tidy(current.replace(old, edit.new.trim()))
    } else if (edit.new.trim() !== '') {
      next[edit.f] = joinSheetText(current, edit.new)
    }
  }
  const own = [...extra]
  const all = [...fields]
  for (const add of adds) {
    const label = add.label.replace(/\s+/g, ' ').trim()
    const value = add.value.trim()
    if (label === '' || value === '') continue
    const named = all.find((field) => field.label.toLowerCase() === label.toLowerCase())
    if (named !== undefined) {
      next[named.id] = joinSheetText(next[named.id], value)
      continue
    }
    if (own.length >= SHEET_EXTRA_FIELDS_MAX) {
      // No room for another field of its own: the Notes keep it, labelled, when the sheet has them.
      if (known.has('notes')) next.notes = joinSheetText(next.notes, `${label}: ${value}`)
      continue
    }
    const id = fieldIdFromLabel(
      label,
      all.map((field) => field.id)
    )
    const field: EntityFieldDef = { id, label: label.slice(0, 60), multiline: true }
    own.push(field)
    all.push(field)
    known.add(id)
    next[id] = value
  }
  return { values: next, extra: own }
}
