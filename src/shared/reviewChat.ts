import { z } from 'zod'
import { AiErrorCode, AiUsage } from './ai'
import {
  BUILTIN_CATEGORIES as BUILTIN_LOOKUP,
  categoryFieldLabel,
  categoryOf,
  isKnownCategory,
  type StoryCategory
} from './categories'
import {
  buildReviewEntity,
  canSplit,
  isEmptyUpdate,
  recordAsKind,
  splitReviewEntity,
  type ContextRecord,
  type ContextReview,
  type ContextReviewEntity,
  type ContextReviewField,
  type ExistingSheet
} from './contextLibrary'
import { ENTITY_NAME_MAX, toEntityNameKey, type EntityFieldId, type EntityKind } from './entities'

/**
 * The review chat (F-9.9): on the context library's review screen (F-9.8) the author tells the
 * AI what to change — "merge Rynna and High Crown Falsire", "Kael is a place, not a character",
 * "put the Ashfall war in World, not Notes" — and the model answers with operations on the
 * pending review, never with the review itself. The operations are applied here, in the
 * renderer, to the review as it stands, so nothing is written before Apply and every change is
 * shown (and can be undone) before it lands. One owner for the operation vocabulary, its caps,
 * the channel's result, and the pure `applyReviewOps`.
 *
 * Aliases: until a first-class alias model exists, an item's other names are its records' names
 * and `aliases` (what the planner already merges on); `aliases` replaces the explicit list.
 */

/** Longest message the author can send. */
export const REVIEW_CHAT_MESSAGE_MAX = 2_000
/** Earlier turns sent with a message, and the characters kept of each. */
export const REVIEW_CHAT_HISTORY_TURNS = 4
export const REVIEW_CHAT_TURN_CHARS = 400
/** Operations kept from one answer; the rest are dropped and counted. */
export const REVIEW_CHAT_MAX_OPS = 30
/** The review as the prompt lists it: at most this many characters of items, then of notes. */
export const REVIEW_CHAT_ITEMS_CHARS = 14_000
export const REVIEW_CHAT_NOTES_CHARS = 3_000
/** The answer's cap, and the one retry's after an answer that was cut off or did not parse. */
export const REVIEW_CHAT_MAX_TOKENS = 1_500
export const REVIEW_CHAT_RETRY_MAX_TOKENS = 3_000

/** The id an `include` operation gives the Project notes card. */
export const REVIEW_NOTES_ID = 'notes'

const Name = z.string().trim().min(1).max(ENTITY_NAME_MAX)

/**
 * A category as the model may spell it: an id ("setting", " Magic "), a name ("Magic Systems"),
 * or a singular; `resolveKind` reads it against the review's categories (F-9.11).
 */
const LooseKind = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.string().min(1).max(80)
)

/** One change to the pending review. Item ids and note numbers are the ones the prompt listed. */
export const ReviewOp = z.discriminatedUnion('op', [
  /** One sheet from several items; `name` is the main (full) name, the others become its aliases. */
  z.object({
    op: z.literal('merge'),
    items: z.array(z.string()).min(2),
    name: Name.optional()
  }),
  /** A merged item back into one per name (F-9.8's Split). */
  z.object({ op: z.literal('split'), item: z.string() }),
  /** A different category: any library category, the project's own, or one proposed in the review. */
  z.object({ op: z.literal('kind'), item: z.string(), kind: LooseKind }),
  /** Into Project notes instead of a sheet. */
  z.object({ op: z.literal('toNotes'), item: z.string() }),
  /** Project notes (1-based numbers) into a sheet of their own, or into the item of that name. */
  z.object({
    op: z.literal('fromNotes'),
    notes: z.array(z.number().int().positive()).min(1),
    kind: LooseKind,
    name: Name
  }),
  /** A new sheet's main name. */
  z.object({ op: z.literal('rename'), item: z.string(), name: Name }),
  /** The item's other names and titles, as a whole list. */
  z.object({ op: z.literal('aliases'), item: z.string(), aliases: z.array(z.string()) }),
  /** Include or leave out an item, or `notes` for the Project notes. */
  z.object({ op: z.literal('include'), item: z.string(), include: z.boolean() })
])
export type ReviewOp = z.infer<typeof ReviewOp>

/** One earlier turn of the review conversation. */
export const ReviewChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string()
})
export type ReviewChatTurn = z.infer<typeof ReviewChatTurn>

export const ReviewChatResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ops: z.array(ReviewOp),
    /** The model's one or two sentences about what it changed, or why it could not. */
    reply: z.string(),
    /** Operations that did not parse or were over `REVIEW_CHAT_MAX_OPS`. */
    dropped: z.number().int().nonnegative(),
    usage: AiUsage,
    costUsd: z.number().nonnegative(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type ReviewChatResult = z.infer<typeof ReviewChatResult>

/** What one operation did to the review, for the chat log; `skipped` carries why it did nothing. */
export interface ReviewChange {
  text: string
  /** The items (or `REVIEW_NOTES_ID`) to mark as changed on the review. */
  itemIds: string[]
  skipped: boolean
}

// ---------------------------------------------------------------------------------------------
// The other names of an item

/** An item's other names: its records' names and aliases, minus its own name, first spelling kept. */
export function itemAliases(item: Pick<ContextReviewEntity, 'name' | 'records'>): string[] {
  const seen = new Set([toEntityNameKey(item.name)])
  const names: string[] = []
  for (const name of item.records.flatMap((record) => [record.name, ...record.aliases])) {
    const key = toEntityNameKey(name)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    names.push(name.trim())
  }
  return names
}

// ---------------------------------------------------------------------------------------------
// Applying operations

const quote = (name: string): string => `“${name}”`

/** The review's categories: the project's own and the proposed ones (F-9.11). */
const categoriesOf = (review: ContextReview): readonly StoryCategory[] => review.categories

/**
 * The category id the model meant by `text`: an id, a name, or a singular of a library category,
 * the project's own, or one proposed in the review; null when none fits.
 */
export function resolveKind(review: ContextReview, text: string): EntityKind | null {
  const key = text.trim().toLowerCase()
  if (isKnownCategory(key, review.categories)) return key
  const all = [
    ...review.categories,
    ...BUILTIN_LOOKUP.filter((c) => !review.categories.some((own) => own.id === c.id))
  ]
  const hit = all.find(
    (category) => category.name.toLowerCase() === key || category.noun.toLowerCase() === key
  )
  return hit?.id ?? null
}

/** A field's pick carries over only where the same values meet again (a fill never becomes a conflict's pick). */
const pickKey = (field: ContextReviewField): string =>
  `${field.field}\0${field.upload}\0${field.existing ?? ''}`

/** The rebuilt item keeps the author's earlier picks where the same field still has the same values. */
function keepPicks(next: ContextReviewEntity, before: readonly ContextReviewEntity[]): void {
  const picks = new Map<string, { include: boolean; choice: 'upload' | 'existing' }>()
  for (const item of before) {
    for (const field of item.fields) picks.set(pickKey(field), field)
  }
  next.fields = next.fields.map((field) => {
    const pick = picks.get(pickKey(field))
    return pick ? { ...field, include: pick.include, choice: pick.choice } : field
  })
  const first = before[0]
  if (first !== undefined) next.includeDetails = first.includeDetails
}

/** The paragraphs an item would leave in Project notes: its fields and details, under its name. */
function asNotes(item: ContextReviewEntity, categories: readonly StoryCategory[]): string[] {
  const category = categoryOf(item.kind, categories)
  const labelOf = (id: EntityFieldId): string => categoryFieldLabel(category, id)
  return [
    ...item.fields.map((field) => `${item.name}, ${labelOf(field.field)}: ${field.upload}`),
    ...item.details.map((detail) => `${item.name}, ${detail}`)
  ]
}

interface OpContext {
  review: ContextReview
  existing: readonly ExistingSheet[]
  nextId: () => string
}

interface OpOutcome {
  review: ContextReview
  change: ReviewChange
}

const skip = (review: ContextReview, text: string): OpOutcome => ({
  review,
  change: { text, itemIds: [], skipped: true }
})

/** The existing sheet of `kind` an item of these names would fill, unless another item holds it. */
function sheetFor(
  ctx: OpContext,
  kind: EntityKind,
  names: readonly string[],
  except: string
): ExistingSheet | null {
  const taken = new Set(
    ctx.review.entities.filter((e) => e.id !== except).flatMap((e) => e.existingId ?? [])
  )
  const keys = names.map(toEntityNameKey)
  return (
    ctx.existing.find(
      (sheet) =>
        sheet.kind === kind && !taken.has(sheet.id) && keys.includes(toEntityNameKey(sheet.name))
    ) ?? null
  )
}

/** The item of `kind` already called `name` in the review (by its name or another name). */
function itemNamed(
  review: ContextReview,
  kind: EntityKind,
  name: string,
  except: string | null
): ContextReviewEntity | undefined {
  const key = toEntityNameKey(name)
  return review.entities.find(
    (item) =>
      item.id !== except &&
      item.kind === kind &&
      [item.name, ...itemAliases(item)].some((n) => toEntityNameKey(n) === key)
  )
}

function replaceItems(
  review: ContextReview,
  at: string,
  next: ContextReviewEntity,
  removed: readonly string[]
): ContextReview {
  return {
    ...review,
    entities: review.entities
      .map((item) => (item.id === at ? next : item))
      .filter((item) => item.id === at || !removed.includes(item.id))
  }
}

function merge(ctx: OpContext, op: Extract<ReviewOp, { op: 'merge' }>): OpOutcome {
  const { review } = ctx
  const ids = [...new Set(op.items)]
  const items = ids.flatMap((id) => review.entities.find((item) => item.id === id) ?? [])
  if (items.length < 2) return skip(review, `Merge skipped: it needs two items of the list.`)
  const sheets = new Set(items.flatMap((item) => item.existingId ?? []))
  if (sheets.size > 1) {
    return skip(
      review,
      `Merge skipped: ${items.map((i) => quote(i.name)).join(' and ')} are already separate sheets; merge those in the story bible.`
    )
  }
  const target = items.find((item) => item.existingId !== null) ?? items[0]
  if (target === undefined) return skip(review, 'Merge skipped.')
  const ordered = [target, ...items.filter((item) => item !== target)]
  const categories = categoriesOf(review)
  const records = ordered.flatMap((item) =>
    item.records.map((r) => recordAsKind(r, target.kind, categories))
  )
  if (records.length === 0) return skip(review, 'Merge skipped: those items hold nothing to merge.')
  const sheet = ctx.existing.find((s) => s.id === target.existingId) ?? null
  const next = buildReviewEntity(target.id, records, sheet, categories)
  // A new sheet takes the main name asked for; the merged items' names become its other names.
  if (sheet === null) next.name = op.name ?? target.name
  next.tag = sheet === null ? (target.tag ?? true) : next.tag
  next.include = true
  next.images = categoryOf(target.kind, categories).hasImage
    ? (ordered.find((item) => item.images.length > 0)?.images ?? [])
    : []
  keepPicks(next, ordered)
  const others = ordered.slice(1)
  return {
    review: replaceItems(
      review,
      target.id,
      next,
      others.map((item) => item.id)
    ),
    change: {
      text: `Merged ${others.map((i) => quote(i.name)).join(', ')} into ${quote(next.name)}.`,
      itemIds: [target.id],
      skipped: false
    }
  }
}

function split(ctx: OpContext, op: Extract<ReviewOp, { op: 'split' }>): OpOutcome {
  const item = ctx.review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(ctx.review, `Split skipped: no item ${op.item}.`)
  if (!canSplit(item)) {
    return skip(ctx.review, `Split skipped: ${quote(item.name)} holds only one name.`)
  }
  const next = splitReviewEntity(ctx.review, item.id, ctx.existing)
  const parts = next.entities.filter((e) => e.id.startsWith(`${item.id}.`))
  return {
    review: next,
    change: {
      text: `Split ${quote(item.name)} into ${parts.map((p) => quote(p.name)).join(', ')}.`,
      itemIds: parts.map((p) => p.id),
      skipped: false
    }
  }
}

function changeKind(ctx: OpContext, op: Extract<ReviewOp, { op: 'kind' }>): OpOutcome {
  const { review } = ctx
  const item = review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(review, `Change of kind skipped: no item ${op.item}.`)
  const kind = resolveKind(review, op.kind)
  if (kind === null)
    return skip(review, `Change of kind skipped: there is no category ${quote(op.kind)}.`)
  const categories = categoriesOf(review)
  const noun = categoryOf(kind, categories).noun
  if (item.kind === kind) {
    return skip(review, `${quote(item.name)} is already a ${noun}.`)
  }
  const records = item.records.map((record) => recordAsKind(record, kind, categories))
  if (records.length === 0) {
    return skip(review, `${quote(item.name)} is an existing sheet with only a picture to add.`)
  }
  // A same-named item of that kind already in the review takes these descriptions.
  const into = itemNamed(review, kind, item.name, item.id)
  if (into !== undefined) {
    const sheet = ctx.existing.find((s) => s.id === into.existingId) ?? null
    const next = buildReviewEntity(into.id, [...into.records, ...records], sheet, categories)
    if (sheet === null) next.name = into.name
    next.images = into.images
    keepPicks(next, [into, item])
    return {
      review: replaceItems(review, into.id, next, [item.id]),
      change: {
        text: `${quote(item.name)} is now a ${noun}, merged into ${quote(into.name)}.`,
        itemIds: [into.id],
        skipped: false
      }
    }
  }
  const names = [item.name, ...itemAliases(item)]
  const sheet = sheetFor(ctx, kind, names, item.id)
  const next = buildReviewEntity(item.id, records, sheet, categories)
  if (sheet === null) next.name = item.name
  next.images = categoryOf(kind, categories).hasImage ? item.images : []
  next.include = item.include
  keepPicks(next, [item])
  return {
    review: replaceItems(review, item.id, next, []),
    change: {
      text: `${quote(item.name)} is now a ${noun}${sheet === null ? ' (a new sheet)' : `, filling the sheet ${quote(sheet.name)}`}.`,
      itemIds: [item.id],
      skipped: false
    }
  }
}

function toNotes(ctx: OpContext, op: Extract<ReviewOp, { op: 'toNotes' }>): OpOutcome {
  const { review } = ctx
  const item = review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(review, `Move to Project notes skipped: no item ${op.item}.`)
  const seen = new Set(review.notes.paragraphs.map(toEntityNameKey))
  const added = asNotes(item, categoriesOf(review)).filter((p) => !seen.has(toEntityNameKey(p)))
  return {
    review: {
      ...review,
      entities: review.entities.filter((e) => e.id !== item.id),
      notes: {
        ...review.notes,
        paragraphs: [...review.notes.paragraphs, ...added],
        include: review.notes.include || added.length > 0
      }
    },
    change: {
      text: `Moved ${quote(item.name)} to Project notes${added.length === 0 ? ' (nothing to add there)' : ''}.`,
      itemIds: added.length > 0 ? [REVIEW_NOTES_ID] : [],
      skipped: false
    }
  }
}

function fromNotes(ctx: OpContext, op: Extract<ReviewOp, { op: 'fromNotes' }>): OpOutcome {
  const { review } = ctx
  const kind = resolveKind(review, op.kind)
  if (kind === null) {
    return skip(review, `Move from Project notes skipped: there is no category ${quote(op.kind)}.`)
  }
  const categories = categoriesOf(review)
  const numbers = [...new Set(op.notes)].filter((n) => n <= review.notes.paragraphs.length)
  if (numbers.length === 0) return skip(review, 'Move from Project notes skipped: no such note.')
  const paragraphs = numbers.flatMap((n) => review.notes.paragraphs[n - 1] ?? [])
  const record: ContextRecord = {
    id: `${ctx.nextId()}r`,
    fileId: review.fileIds[0] ?? '',
    fileName: 'Project notes',
    kind,
    name: op.name,
    aliases: [],
    fields: {},
    details: paragraphs
  }
  const notes = {
    ...review.notes,
    paragraphs: review.notes.paragraphs.filter((_, i) => !numbers.includes(i + 1))
  }
  const into = itemNamed(review, kind, op.name, null)
  const noteWord = numbers.length === 1 ? 'note' : `${numbers.length} notes`
  if (into !== undefined) {
    const sheet = ctx.existing.find((s) => s.id === into.existingId) ?? null
    const next = buildReviewEntity(into.id, [...into.records, record], sheet, categories)
    if (sheet === null) next.name = into.name
    next.images = into.images
    next.tag = sheet === null ? into.tag : next.tag
    keepPicks(next, [into])
    return {
      review: { ...replaceItems(review, into.id, next, []), notes },
      change: {
        text: `Moved the ${noteWord} into ${quote(into.name)}.`,
        itemIds: [into.id],
        skipped: false
      }
    }
  }
  const sheet = sheetFor(ctx, kind, [op.name], '')
  const next = buildReviewEntity(ctx.nextId(), [record], sheet, categories)
  if (isEmptyUpdate(next)) {
    return skip(review, `${quote(op.name)} already says what those notes say.`)
  }
  return {
    review: { ...review, entities: [...review.entities, next], notes },
    change: {
      text: `Made ${quote(next.name)} a ${categoryOf(kind, categories).noun} from the ${noteWord}.`,
      itemIds: [next.id],
      skipped: false
    }
  }
}

function rename(ctx: OpContext, op: Extract<ReviewOp, { op: 'rename' }>): OpOutcome {
  const { review } = ctx
  const item = review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(review, `Rename skipped: no item ${op.item}.`)
  if (item.existingId !== null) {
    return skip(
      review,
      `Rename skipped: ${quote(item.name)} is an existing sheet; rename it in the story bible.`
    )
  }
  if (toEntityNameKey(op.name) === toEntityNameKey(item.name)) {
    return skip(review, `${quote(item.name)} already has that name.`)
  }
  const clash = review.entities.find(
    (e) =>
      e.id !== item.id &&
      e.kind === item.kind &&
      toEntityNameKey(e.name) === toEntityNameKey(op.name)
  )
  if (clash !== undefined) {
    return skip(review, `Rename skipped: ${quote(clash.name)} is already in the list; merge them.`)
  }
  const taken = ctx.existing.find(
    (s) => s.kind === item.kind && toEntityNameKey(s.name) === toEntityNameKey(op.name)
  )
  if (taken !== undefined) {
    return skip(review, `Rename skipped: the story bible already has ${quote(taken.name)}.`)
  }
  // The old name stays one of its other names: it is a record's name.
  const next = { ...item, name: op.name }
  return {
    review: replaceItems(review, item.id, next, []),
    change: {
      text: `Renamed ${quote(item.name)} to ${quote(op.name)}.`,
      itemIds: [item.id],
      skipped: false
    }
  }
}

function setAliases(ctx: OpContext, op: Extract<ReviewOp, { op: 'aliases' }>): OpOutcome {
  const { review } = ctx
  const item = review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(review, `Other names skipped: no item ${op.item}.`)
  const [first, ...rest] = item.records
  if (first === undefined) {
    return skip(review, `${quote(item.name)} has no description to carry other names.`)
  }
  const own = toEntityNameKey(item.name)
  const seen = new Set<string>()
  const aliases = op.aliases
    .map((alias) => alias.trim().slice(0, ENTITY_NAME_MAX))
    .filter((alias) => {
      const key = toEntityNameKey(alias)
      if (key === '' || key === own || seen.has(key)) return false
      seen.add(key)
      return true
    })
  const next: ContextReviewEntity = {
    ...item,
    records: [{ ...first, aliases }, ...rest.map((record) => ({ ...record, aliases: [] }))]
  }
  const shown = itemAliases(next)
  return {
    review: replaceItems(review, item.id, next, []),
    change: {
      text:
        shown.length === 0
          ? `${quote(item.name)} has no other names now.`
          : `${quote(item.name)} is also called ${shown.map(quote).join(', ')}.`,
      itemIds: [item.id],
      skipped: false
    }
  }
}

function include(ctx: OpContext, op: Extract<ReviewOp, { op: 'include' }>): OpOutcome {
  const { review } = ctx
  const verb = op.include ? 'Included' : 'Left out'
  if (op.item === REVIEW_NOTES_ID) {
    return {
      review: { ...review, notes: { ...review.notes, include: op.include } },
      change: { text: `${verb} the Project notes.`, itemIds: [REVIEW_NOTES_ID], skipped: false }
    }
  }
  const item = review.entities.find((e) => e.id === op.item)
  if (item === undefined) return skip(review, `${verb} skipped: no item ${op.item}.`)
  return {
    review: replaceItems(review, item.id, { ...item, include: op.include }, []),
    change: { text: `${verb} ${quote(item.name)}.`, itemIds: [item.id], skipped: false }
  }
}

function applyOne(ctx: OpContext, op: ReviewOp): OpOutcome {
  switch (op.op) {
    case 'merge':
      return merge(ctx, op)
    case 'split':
      return split(ctx, op)
    case 'kind':
      return changeKind(ctx, op)
    case 'toNotes':
      return toNotes(ctx, op)
    case 'fromNotes':
      return fromNotes(ctx, op)
    case 'rename':
      return rename(ctx, op)
    case 'aliases':
      return setAliases(ctx, op)
    case 'include':
      return include(ctx, op)
  }
}

/**
 * Applies the model's operations to the review in order (F-9.9). Each sees the review the one
 * before it left; an operation that names an item no longer there, or asks for something the
 * review cannot do (merging two existing sheets, renaming one), is skipped with the reason. New
 * items get ids `c<n>` past any the review already has. Pure: the review passed in is not changed.
 */
export function applyReviewOps(
  review: ContextReview,
  ops: readonly ReviewOp[],
  existing: readonly ExistingSheet[]
): { review: ContextReview; changes: ReviewChange[] } {
  let counter = 0
  const used = (id: string): boolean => current.entities.some((item) => item.id === id)
  const nextId = (): string => {
    let id = `c${++counter}`
    while (used(id)) id = `c${++counter}`
    return id
  }
  let current = review
  const changes: ReviewChange[] = []
  for (const op of ops) {
    const outcome = applyOne({ review: current, existing, nextId }, op)
    current = outcome.review
    changes.push(outcome.change)
  }
  return { review: current, changes }
}
