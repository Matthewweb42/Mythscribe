import { z } from 'zod'
import { AiErrorCode, AiUsage, priceFor } from './ai'
import { IMAGE_EXTENSIONS, imageExtension } from './assets'
import { StoryCategory, categoryFieldLabel, categoryOf, isCategoryField } from './categories'
import {
  ENTITY_FIELD_MAX,
  EntityFieldId,
  EntityKind,
  toEntityNameKey,
  type EntityFields
} from './entities'

/**
 * The context library (F-9.8): the author's own worldbuilding documents, character notes, maps,
 * and art, uploaded into the project, kept as originals under `assets/library/`, and sorted by
 * the AI into the story bible after a review. One owner for the accepted file types, the stored
 * row as the renderer sees it, the chunking of a document into requests, the estimate, the
 * review the author edits before anything is written, and the pure planner that turns what the
 * model read into that review (matching names and nicknames across files and existing sheets,
 * flagging conflicts, dropping what the story bible already says).
 */

/** What an uploaded file is; images are kept as references and never read for text. */
export const CONTEXT_FILE_TYPES = ['docx', 'md', 'txt', 'pdf', 'image'] as const
export const ContextFileType = z.enum(CONTEXT_FILE_TYPES)
export type ContextFileType = z.infer<typeof ContextFileType>

export const CONTEXT_FILE_TYPE_LABEL: Record<ContextFileType, string> = {
  docx: 'Word',
  md: 'Markdown',
  txt: 'Text',
  pdf: 'PDF',
  image: 'Image'
}

/** The text extensions the library reads (any case); images are `IMAGE_EXTENSIONS`. */
export const CONTEXT_TEXT_EXTENSIONS: Record<string, Exclude<ContextFileType, 'image'>> = {
  docx: 'docx',
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  pdf: 'pdf'
}

/** Every extension the open dialog offers, text first. */
export const CONTEXT_EXTENSIONS: readonly string[] = [
  ...Object.keys(CONTEXT_TEXT_EXTENSIONS),
  ...IMAGE_EXTENSIONS
]

/** Largest file copied into the library; anything bigger is skipped before it is read. */
export const CONTEXT_FILE_MAX_BYTES = 25 * 1024 * 1024

/** The library folder under the project's `assets/` (not served: originals open in the OS). */
export const CONTEXT_LIBRARY_DIR = 'library'

/** The type of a file by its extension, or null for one the library does not take. */
export function contextFileTypeOf(fileName: string): ContextFileType | null {
  if (imageExtension(fileName) !== null) return 'image'
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  return CONTEXT_TEXT_EXTENSIONS[fileName.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Where a file stands: `new` (never sorted), `changed` (a newer version was uploaded since it was
 * sorted), `processed`, `reference` (an image: kept, never read), `noText` (a scanned or empty
 * PDF or document: there is nothing to sort, and no OCR).
 */
export const CONTEXT_FILE_STATES = ['new', 'changed', 'processed', 'reference', 'noText'] as const
export const ContextFileState = z.enum(CONTEXT_FILE_STATES)
export type ContextFileState = z.infer<typeof ContextFileState>

export const CONTEXT_FILE_STATE_LABEL: Record<ContextFileState, string> = {
  new: 'Not sorted yet',
  changed: 'Updated, not sorted',
  processed: 'Sorted',
  reference: 'Reference image',
  noText: 'No text found'
}

/** The state of a stored row, derived from its hashes so it can never disagree with them. */
export function contextFileState(row: {
  type: ContextFileType
  textHash: string | null
  processedHash: string | null
}): ContextFileState {
  if (row.type === 'image') return 'reference'
  if (row.textHash === null) return 'noText'
  if (row.processedHash === null) return 'new'
  return row.processedHash === row.textHash ? 'processed' : 'changed'
}

/** Whether a file of this state has text the AI could sort (again). */
export function isSortable(state: ContextFileState): boolean {
  return state === 'new' || state === 'changed' || state === 'processed'
}

/** One uploaded file as the Library tab lists it. */
export const ContextFile = z.object({
  id: z.string(),
  /** The original file name, as the author named it. */
  name: z.string(),
  type: ContextFileType,
  size: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  state: ContextFileState,
  created: z.string(),
  modified: z.string(),
  processedAt: z.string().nullable()
})
export type ContextFile = z.infer<typeof ContextFile>

/** A file the add refused, with why (an unsupported type, too large, unreadable). */
export const ContextSkipped = z.object({ name: z.string(), reason: z.string() })
export type ContextSkipped = z.infer<typeof ContextSkipped>

/**
 * What an add answers: the whole library as it now stands, the ids of the files that are new or
 * changed (what the caller offers to sort), how many were identical to the stored original, and
 * what was skipped.
 */
export const ContextAddResult = z.object({
  files: z.array(ContextFile),
  changed: z.array(z.string()),
  unchanged: z.number().int().nonnegative(),
  skipped: z.array(ContextSkipped)
})
export type ContextAddResult = z.infer<typeof ContextAddResult>

// ---------------------------------------------------------------------------------------------
// Chunking and the estimate

/**
 * Characters of document text per request (~2,000 tokens), cut at paragraph boundaries; halved
 * from 16,000 on 2026-10-08, when dense worldbuilding pages overran the answer cap.
 */
export const CONTEXT_CHUNK_CHARS = 8_000
/** The existing sheet names the prompt lists, at most this many characters in all. */
export const CONTEXT_SHEET_NAMES_CHARS = 6_000
/** Image file names the prompt lists, at most. */
export const CONTEXT_IMAGE_NAMES_MAX = 40
/** The estimate's per-request overhead: the rules, the sheet names, the image names. */
export const CONTEXT_CHUNK_OVERHEAD_TOKENS = 900
/** The estimate's answer per request; the cap is `outputBudget('contextImport')`. */
export const CONTEXT_OUT_TOKENS_PER_CHUNK = 1_500

/** One paragraph per blank-line-separated block, whitespace inside collapsed, empty ones dropped. */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/[ \t]+/g, ' ').trim())
    .filter((block) => block !== '')
}

/** The key two paragraphs are compared by: whitespace collapsed, lower-cased. */
export function paragraphKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The paragraphs of `current` that `previous` did not have (F-9.8 re-upload): an updated file is
 * sorted again only for what changed, so the review shows new or changed information only.
 */
export function changedParagraphs(
  current: readonly string[],
  previous: readonly string[]
): string[] {
  const seen = new Set(previous.map(paragraphKey))
  return current.filter((paragraph) => !seen.has(paragraphKey(paragraph)))
}

/** A paragraph longer than `max` cut at sentence ends, then hard, so every piece fits. */
function cutLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph]
  const pieces: string[] = []
  let rest = paragraph
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'))
    const at = end > max / 2 ? end + 1 : max
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/** Paragraphs greedily packed into chunks of at most `max` characters; a paragraph is split only when it alone is over. */
export function chunkParagraphs(
  paragraphs: readonly string[],
  max = CONTEXT_CHUNK_CHARS
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs.flatMap((p) => cutLong(p, max))) {
    const joined = current === '' ? paragraph : `${current}\n\n${paragraph}`
    if (joined.length > max && current !== '') {
      chunks.push(current)
      current = paragraph
    } else {
      current = joined
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/** What sorting the chosen files would cost, shown before anything is sent. */
export const ContextEstimate = z.object({
  /** Files with something to send (new or changed text). */
  files: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  priced: z.boolean(),
  /** The strong tier's model, or '' while no AI source is set up. */
  model: z.string()
})
export type ContextEstimate = z.infer<typeof ContextEstimate>

/** The estimate for chunks of these sizes (characters) on `model`. */
export function estimateContextCost(
  chunkChars: readonly number[],
  files: number,
  model: string
): ContextEstimate {
  const chunks = chunkChars.length
  const tokensIn =
    chunkChars.reduce((sum, chars) => sum + Math.ceil(chars / 4), 0) +
    chunks * CONTEXT_CHUNK_OVERHEAD_TOKENS
  const tokensOut = chunks * CONTEXT_OUT_TOKENS_PER_CHUNK
  const price = priceFor(model, tokensIn, tokensOut)
  return { files, chunks, tokensIn, tokensOut, costUsd: price.costUsd, priced: price.priced, model }
}

export const ContextProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative()
})
export type ContextProgress = z.infer<typeof ContextProgress>

// ---------------------------------------------------------------------------------------------
// What the model read, and the review

/** The fields the AI may fill per category: the template's, minus Notes, which takes the details. */
export function contextFieldsFor(category: StoryCategory): readonly EntityFieldId[] {
  return category.fields.map((field) => field.id).filter((id) => id !== 'notes')
}

/** The categories the review's lookups go by (F-9.11): the project's own and the proposed ones. */
type Categories = readonly StoryCategory[]

/**
 * A category of the review (F-9.11): one of the project's own (`proposed` false, carried so the
 * pure planner knows its template), or one the AI invented while sorting (`proposed` true), shown
 * to the author as a proposed new category. Apply creates every proposed category that still has
 * an included item; declining one moves its items to World first (`declineReviewCategory`).
 */
export const ContextReviewCategory = StoryCategory.extend({ proposed: z.boolean() })
export type ContextReviewCategory = z.infer<typeof ContextReviewCategory>

/** New categories one sort may propose (F-9.11); things in any further ones are filed under World. */
export const CONTEXT_PROPOSED_CATEGORIES_MAX = 6
/** Fields of one proposed category, Notes not counted. */
export const CONTEXT_PROPOSED_FIELDS_MAX = 6

/** The name of the World page that takes what fits no sheet (themes, plot outline, rules). */
export const PROJECT_NOTES_NAME = 'Project notes'

/** One person, place, or thing as one chunk of one file described it. */
export const ContextRecord = z.object({
  id: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  kind: EntityKind,
  name: z.string(),
  aliases: z.array(z.string()),
  fields: z.partialRecord(EntityFieldId, z.string()),
  details: z.array(z.string())
})
export type ContextRecord = z.infer<typeof ContextRecord>

/** The model's guess at whose picture an uploaded image is. */
export interface ContextImageHint {
  fileName: string
  name: string
}

/**
 * One field of one sheet in the review. `existing` is null when the sheet has no value there (a
 * plain fill, `include` decides); otherwise the values conflict and `choice` is the author's pick
 * (`existing` by default, so accepting everything never overwrites what they wrote).
 */
export const ContextReviewField = z.object({
  field: EntityFieldId,
  upload: z.string(),
  existing: z.string().nullable(),
  include: z.boolean(),
  choice: z.enum(['upload', 'existing'])
})
export type ContextReviewField = z.infer<typeof ContextReviewField>

/** An uploaded image the review would make a sheet's picture. */
export const ContextReviewImage = z.object({
  fileId: z.string(),
  fileName: z.string(),
  include: z.boolean(),
  /** True when the sheet already has a picture this one would replace. */
  replaces: z.boolean()
})
export type ContextReviewImage = z.infer<typeof ContextReviewImage>

/**
 * One sheet to create or fill. `records` are the descriptions merged into it (one per file and
 * chunk that named it), so the review can show each match and split it again. `tag` is whether
 * the sheet gets the tag of its name (F-9.4), null when the existing sheet already has one.
 * `details` go to the sheet's free-text place: the Notes field of a structured sheet, the page
 * of a blank one.
 */
export const ContextReviewEntity = z.object({
  id: z.string(),
  kind: EntityKind,
  name: z.string(),
  existingId: z.string().nullable(),
  include: z.boolean(),
  tag: z.boolean().nullable(),
  records: z.array(ContextRecord),
  fields: z.array(ContextReviewField),
  details: z.array(z.string()),
  includeDetails: z.boolean(),
  images: z.array(ContextReviewImage)
})
export type ContextReviewEntity = z.infer<typeof ContextReviewEntity>

/** What fits no sheet, for the Project notes page in the World tab. */
export const ContextReviewNotes = z.object({
  existingId: z.string().nullable(),
  paragraphs: z.array(z.string()),
  include: z.boolean()
})
export type ContextReviewNotes = z.infer<typeof ContextReviewNotes>

/** The review the author edits before Apply; nothing has been written while it exists. */
export const ContextReview = z.object({
  fileIds: z.array(z.string()),
  entities: z.array(ContextReviewEntity),
  /** F-9.11: the project's own categories and the AI's proposed new ones (`ContextReviewCategory`). */
  categories: z.array(ContextReviewCategory).default([]),
  notes: ContextReviewNotes,
  /** One proposal per request (F-14.5), settled at Apply or Cancel. */
  proposalIds: z.array(z.string()),
  chunks: z.number().int().nonnegative(),
  usage: AiUsage,
  costUsd: z.number().nonnegative(),
  model: z.string(),
  promptVersion: z.string()
})
export type ContextReview = z.infer<typeof ContextReview>

export const ContextProcessResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), review: ContextReview }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type ContextProcessResult = z.infer<typeof ContextProcessResult>

/** What Apply wrote. */
export const ContextApplyCounts = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  notes: z.boolean()
})
export type ContextApplyCounts = z.infer<typeof ContextApplyCounts>

/** A sheet of the story bible as the planner needs it; `Entity` satisfies it. */
export interface ExistingSheet {
  id: string
  kind: EntityKind
  name: string
  template: 'structured' | 'blank'
  fields: EntityFields
  body: string | null
  image: string | null
  tagId: string | null
  /** F-4.14: the sheet's other names (its tag's, when linked); a record may match by any of them. */
  aliases?: readonly string[]
}

/** Every name key a sheet answers to: its name, then its aliases (F-4.14). */
function sheetKeys(sheet: ExistingSheet): string[] {
  return [sheet.name, ...(sheet.aliases ?? [])].map(toEntityNameKey).filter((key) => key !== '')
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** Where a sheet's details go: the page of a blank sheet, the Notes field of a structured one. */
export function detailsTarget(
  sheet: Pick<ExistingSheet, 'template' | 'fields' | 'body'> | null
): string {
  if (sheet === null) return ''
  return sheet.template === 'blank' ? (sheet.body ?? '') : (sheet.fields.notes ?? '')
}

/** The paragraphs not yet in `existing` (normalized), first occurrence kept. */
function newParagraphs(paragraphs: readonly string[], existing: string): string[] {
  const inside = norm(existing)
  const seen = new Set<string>()
  const kept: string[] = []
  for (const paragraph of paragraphs) {
    const key = norm(paragraph)
    if (key === '' || seen.has(key) || inside.includes(key)) continue
    seen.add(key)
    kept.push(paragraph.trim())
  }
  return kept
}

/** Every name key a record answers to: its name and its aliases. */
function keysOf(record: Pick<ContextRecord, 'name' | 'aliases'>): string[] {
  return [record.name, ...record.aliases].map(toEntityNameKey).filter((key) => key !== '')
}

/** One field's merged upload value: distinct values in record order, joined by the field's shape. */
function mergedValue(
  category: StoryCategory,
  field: EntityFieldId,
  records: readonly ContextRecord[]
): string {
  const values: string[] = []
  for (const record of records) {
    const value = record.fields[field]?.trim() ?? ''
    if (value === '' || values.some((seen) => norm(seen) === norm(value))) continue
    values.push(value)
  }
  const multiline = category.fields.find((def) => def.id === field)?.multiline ?? true
  return values.join(multiline ? '\n\n' : ' / ').slice(0, ENTITY_FIELD_MAX)
}

/** The review fields for a group of records against the sheet it matched (or none). */
function reviewFields(
  category: StoryCategory,
  records: readonly ContextRecord[],
  sheet: ExistingSheet | null
): ContextReviewField[] {
  const fields: ContextReviewField[] = []
  for (const field of contextFieldsFor(category)) {
    const upload = mergedValue(category, field, records)
    if (upload === '') continue
    const existing = sheet?.fields[field]?.trim() ?? ''
    if (existing === '') {
      fields.push({ field, upload, existing: null, include: true, choice: 'upload' })
      continue
    }
    // The sheet already says it (or says more): nothing new to review.
    if (norm(existing) === norm(upload) || norm(existing).includes(norm(upload))) continue
    fields.push({ field, upload, existing, include: true, choice: 'existing' })
  }
  return fields
}

interface PlanInput {
  records: readonly ContextRecord[]
  existing: readonly ExistingSheet[]
  /** The review's categories (F-9.11): the project's own and the proposed ones. */
  categories: readonly ContextReviewCategory[]
  /** The images uploaded with (or before) these files, with the model's guesses at whose they are. */
  images: readonly { id: string; name: string }[]
  hints: readonly ContextImageHint[]
  notes: readonly string[]
}

/** Groups records of one kind that share any name key (union-find over names and aliases). */
function groupRecords(records: readonly ContextRecord[]): ContextRecord[][] {
  const parent = records.map((_, i) => i)
  const find = (i: number): number => {
    let at = i
    while (parent[at] !== at) at = parent[at] ?? at
    return at
  }
  const owner = new Map<string, number>()
  records.forEach((record, i) => {
    for (const key of keysOf(record)) {
      const k = `${record.kind}\0${key}`
      const seen = owner.get(k)
      if (seen === undefined) owner.set(k, i)
      else parent[find(i)] = find(seen)
    }
  })
  const groups = new Map<number, ContextRecord[]>()
  records.forEach((record, i) => {
    const root = find(i)
    groups.set(root, [...(groups.get(root) ?? []), record])
  })
  return [...groups.values()]
}

/**
 * The sheet a group of records describes: an existing sheet of the kind named by a record's own
 * name first, then by a record's alias, then by one of the sheet's own aliases (F-4.14: the
 * file says "Rynna", the sheet "Rynna Falsire" with the alias Rynna); null for a new one.
 * `taken` keeps two groups off one sheet.
 */
function matchSheet(
  group: readonly ContextRecord[],
  existing: readonly ExistingSheet[],
  taken: ReadonlySet<string>
): ExistingSheet | null {
  const kind = group[0]?.kind
  const ofKind = existing.filter((sheet) => sheet.kind === kind && !taken.has(sheet.id))
  const byKey = new Map(ofKind.map((sheet) => [toEntityNameKey(sheet.name), sheet]))
  for (const record of group) {
    const hit = byKey.get(toEntityNameKey(record.name))
    if (hit) return hit
  }
  for (const record of group) {
    for (const key of keysOf(record)) {
      const hit = byKey.get(key)
      if (hit) return hit
    }
  }
  for (const record of group) {
    for (const key of keysOf(record)) {
      const hit = ofKind.find((sheet) => sheetKeys(sheet).includes(key))
      if (hit) return hit
    }
  }
  // F-9.11: a sheet of another category with the same name is the same thing filed elsewhere
  // (the author's "The Weave" is a World sheet, the model calls it a magic system): it is filled
  // where it is, never twinned. Moving it is the author's call.
  const others = existing.filter((sheet) => sheet.kind !== kind && !taken.has(sheet.id))
  for (const record of group) {
    const key = toEntityNameKey(record.name)
    const hit = others.find((sheet) => sheetKeys(sheet).includes(key))
    if (hit) return hit
  }
  return null
}

/**
 * A record of another category as one of `kind`: the fields that category's template has stay,
 * the rest become details under their labels (F-9.9, F-9.11).
 */
export function recordAsKind(
  record: ContextRecord,
  kind: EntityKind,
  categories: Categories
): ContextRecord {
  if (record.kind === kind) return record
  const target = categoryOf(kind, categories)
  const source = categoryOf(record.kind, categories)
  const fields: ContextRecord['fields'] = {}
  const moved: string[] = []
  for (const [id, value] of Object.entries(record.fields)) {
    if (value === undefined || value.trim() === '') continue
    if (isCategoryField(target, id) && id !== 'notes') {
      fields[id] = value
    } else {
      moved.push(`${categoryFieldLabel(source, id)}: ${value}`)
    }
  }
  return { ...record, kind, fields, details: [...moved, ...record.details] }
}

/**
 * One review item for a group of records against the sheet it matched (or none): its fields
 * compared, its details minus what the sheet holds, everything included. Also the review chat's
 * rebuild after a merge or a change of kind (F-9.9).
 */
export function buildReviewEntity(
  id: string,
  given: readonly ContextRecord[],
  sheet: ExistingSheet | null,
  categories: Categories
): ContextReviewEntity {
  const head = given[0]
  if (head === undefined) throw new Error('a review item needs a record')
  // A matched sheet keeps its category (F-9.11): the records are read as that category's.
  const kind = sheet?.kind ?? head.kind
  const group = given.map((record) => recordAsKind(record, kind, categories))
  const first = group[0] ?? head
  const details = newParagraphs(
    group.flatMap((record) => record.details),
    detailsTarget(sheet)
  )
  return {
    id,
    kind,
    name: sheet?.name ?? first.name.trim(),
    existingId: sheet?.id ?? null,
    include: true,
    tag: sheet === null ? true : sheet.tagId === null ? true : null,
    records: [...group],
    fields: reviewFields(categoryOf(kind, categories), group, sheet),
    details,
    includeDetails: true,
    images: []
  }
}

/** True when an item for an existing sheet would change nothing. */
export function isEmptyUpdate(item: ContextReviewEntity): boolean {
  return (
    item.existingId !== null &&
    item.fields.length === 0 &&
    item.details.length === 0 &&
    item.images.length === 0 &&
    item.tag === null
  )
}

/** The words of an image file's stem: `mara-vell_portrait.png` → `mara vell portrait`. */
function stemWords(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  return ` ${toEntityNameKey(stem.replace(/[-_.]+/g, ' '))} `
}

/**
 * Attaches each image to one sheet that can carry a picture (a character or a setting): the
 * model's guess first, then a name or alias spelled out in the file name. An image matched to an
 * existing sheet with no other news gets an item of its own; an unmatched image stays a reference
 * in the library only.
 */
function attachImages(
  items: ContextReviewEntity[],
  existing: readonly ExistingSheet[],
  images: PlanInput['images'],
  hints: readonly ContextImageHint[],
  nextId: () => string,
  categories: Categories
): void {
  const hasImage = (kind: EntityKind): boolean => categoryOf(kind, categories).hasImage
  const candidates: {
    keys: string[]
    item: ContextReviewEntity | null
    sheet: ExistingSheet | null
  }[] = [
    ...items
      .filter((item) => hasImage(item.kind))
      .map((item) => ({
        keys: [item.name, ...item.records.flatMap((r) => [r.name, ...r.aliases])]
          .map(toEntityNameKey)
          .filter((key) => key !== ''),
        item,
        sheet: existing.find((sheet) => sheet.id === item.existingId) ?? null
      })),
    ...existing
      .filter((sheet) => hasImage(sheet.kind))
      .filter((sheet) => !items.some((item) => item.existingId === sheet.id))
      .map((sheet) => ({ keys: sheetKeys(sheet), item: null, sheet }))
  ]
  for (const image of images) {
    const hint = hints.find((h) => h.fileName === image.name)
    const hintKey = hint ? toEntityNameKey(hint.name) : ''
    const words = stemWords(image.name)
    const match =
      candidates.find((c) => hintKey !== '' && c.keys.includes(hintKey)) ??
      candidates.find((c) => c.keys.some((key) => words.includes(` ${key} `)))
    if (match === undefined) continue
    const replaces = match.sheet?.image != null
    const entry: ContextReviewImage = {
      fileId: image.id,
      fileName: image.name,
      include: !replaces,
      replaces
    }
    if (match.item !== null) {
      if (match.item.images.length === 0) match.item.images.push(entry)
      continue
    }
    const sheet = match.sheet
    if (sheet === null) continue
    const item: ContextReviewEntity = {
      id: nextId(),
      kind: sheet.kind,
      name: sheet.name,
      existingId: sheet.id,
      include: true,
      tag: null,
      records: [],
      fields: [],
      details: [],
      includeDetails: true,
      images: [entry]
    }
    items.push(item)
    match.item = item
  }
}

/** The Project notes page of the World tab, if the story bible has one. */
export function projectNotesSheet(existing: readonly ExistingSheet[]): ExistingSheet | null {
  const key = toEntityNameKey(PROJECT_NOTES_NAME)
  return existing.find((s) => s.kind === 'world' && toEntityNameKey(s.name) === key) ?? null
}

/**
 * The review for what the model read (F-9.8): records merged across chunks and files by any
 * shared name or nickname, each group matched to an existing sheet by name (then by alias), its
 * fields compared with the sheet's (a fill, a conflict, or nothing new), its details minus what
 * the sheet already holds, images attached, and the leftover notes minus what the Project notes
 * page already says. An existing sheet with nothing new is left out.
 */
export function planContextReview(input: PlanInput): {
  entities: ContextReviewEntity[]
  notes: ContextReviewNotes
  categories: ContextReviewCategory[]
} {
  let count = 0
  const nextId = (): string => `e${++count}`
  const taken = new Set<string>()
  const items: ContextReviewEntity[] = []
  for (const group of groupRecords(input.records)) {
    const sheet = matchSheet(group, input.existing, taken)
    if (sheet !== null) taken.add(sheet.id)
    items.push(buildReviewEntity(nextId(), group, sheet, input.categories))
  }
  attachImages(items, input.existing, input.images, input.hints, nextId, input.categories)
  const notesSheet = projectNotesSheet(input.existing)
  const entities = items.filter((item) => !isEmptyUpdate(item))
  return {
    entities,
    // A proposed category none of the items ended up in (they all matched sheets elsewhere) is
    // not offered.
    categories: input.categories.filter(
      (category) => !category.proposed || entities.some((item) => item.kind === category.id)
    ),
    notes: {
      existingId: notesSheet?.id ?? null,
      paragraphs: newParagraphs(input.notes, notesSheet?.body ?? ''),
      include: true
    }
  }
}

/** Whether a review item merged descriptions under more than one name, so it can be split. */
export function canSplit(item: ContextReviewEntity): boolean {
  return new Set(item.records.map((record) => toEntityNameKey(record.name))).size > 1
}

/**
 * Splits a merged item back into one item per distinct name (F-9.8, "the review shows each match
 * so the author can split it"). The group whose name is the matched sheet's keeps the match (the
 * first group when the match was by nickname only); the others become new sheets under their own
 * names. The item's images stay with the group that keeps the match.
 */
export function splitReviewEntity(
  review: ContextReview,
  itemId: string,
  existing: readonly ExistingSheet[]
): ContextReview {
  const index = review.entities.findIndex((item) => item.id === itemId)
  const item = review.entities[index]
  if (item === undefined || !canSplit(item)) return review
  const groups = new Map<string, ContextRecord[]>()
  for (const record of item.records) {
    const key = toEntityNameKey(record.name)
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const sheet = existing.find((s) => s.id === item.existingId) ?? null
  const sheetKey = sheet === null ? null : toEntityNameKey(sheet.name)
  const keys = [...groups.keys()]
  const keeper = sheet === null ? null : (keys.find((key) => key === sheetKey) ?? keys[0])
  const replaced = keys.map((key, i) => {
    const next = buildReviewEntity(
      `${item.id}.${i + 1}`,
      groups.get(key) ?? [],
      key === keeper ? sheet : null,
      review.categories
    )
    if (key === keeper || (keeper === null && key === keys[0])) next.images = item.images
    return next
  })
  const entities = [...review.entities]
  entities.splice(index, 1, ...replaced.filter((next) => !isEmptyUpdate(next)))
  return { ...review, entities }
}

/** Whether Apply would write anything at all (the files are marked sorted either way). */
export function reviewHasChanges(review: ContextReview): boolean {
  const notes = review.notes.include && review.notes.paragraphs.length > 0
  return (
    notes ||
    review.entities.some(
      (item) =>
        item.include &&
        (item.existingId === null ||
          item.tag === true ||
          item.fields.some(writesField) ||
          (item.includeDetails && item.details.length > 0) ||
          item.images.some((image) => image.include))
    )
  )
}

/** Whether Apply writes this field: included, and either a fill or the upload's value picked. */
export function writesField(field: ContextReviewField): boolean {
  return field.include && (field.existing === null || field.choice === 'upload')
}

/** The fields of a record parsed leniently: only the category's fillable ids, trimmed, non-empty, capped. */
export function recordFields(category: StoryCategory, raw: Record<string, unknown>): EntityFields {
  const fields: EntityFields = {}
  const allowed = contextFieldsFor(category)
  // F-9.11: the model names a proposed category's fields by label ("Home port"); either is taken.
  const byLabel = new Map(
    category.fields
      .filter((field) => allowed.includes(field.id))
      .map((field) => [field.label.trim().toLowerCase(), field.id])
  )
  for (const [given, value] of Object.entries(raw)) {
    const key = allowed.includes(given) ? given : byLabel.get(given.trim().toLowerCase())
    if (key === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const text = String(value).trim().slice(0, ENTITY_FIELD_MAX)
    if (text !== '') fields[key] = text
  }
  return fields
}

/**
 * Declines a category the AI proposed (F-9.11): its items become World sheets (the fields World
 * has stay, the rest move to their details under their labels) and the category leaves the
 * review. An item that then names an existing World sheet fills it. Pure.
 */
export function declineReviewCategory(
  review: ContextReview,
  categoryId: string,
  existing: readonly ExistingSheet[]
): ContextReview {
  const category = review.categories.find((c) => c.id === categoryId && c.proposed)
  if (category === undefined) return review
  const taken = new Set(review.entities.flatMap((item) => item.existingId ?? []))
  const entities = review.entities.map((item) => {
    if (item.kind !== categoryId) return item
    const records = item.records.map((record) => recordAsKind(record, 'world', review.categories))
    const keys = [item.name, ...records.flatMap((r) => [r.name, ...r.aliases])].map(toEntityNameKey)
    const sheet =
      existing.find(
        (s) => s.kind === 'world' && !taken.has(s.id) && keys.includes(toEntityNameKey(s.name))
      ) ?? null
    if (sheet !== null) taken.add(sheet.id)
    const next = buildReviewEntity(item.id, records, sheet, review.categories)
    if (sheet === null) next.name = item.name
    next.include = item.include
    next.tag = sheet === null ? item.tag : next.tag
    next.includeDetails = item.includeDetails
    return next
  })
  return {
    ...review,
    entities: entities.filter((item) => !isEmptyUpdate(item)),
    categories: review.categories.filter((c) => c.id !== categoryId)
  }
}

/** Renames a proposed category before it is created (F-9.11); its singular follows unless set apart. Pure. */
export function renameReviewCategory(
  review: ContextReview,
  categoryId: string,
  name: string
): ContextReview {
  const trimmed = name.trim()
  if (trimmed === '') return review
  return {
    ...review,
    categories: review.categories.map((c) =>
      c.id === categoryId && c.proposed ? { ...c, name: trimmed } : c
    )
  }
}
