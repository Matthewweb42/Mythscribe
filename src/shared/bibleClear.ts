import { z } from 'zod'

/**
 * Clear the story bible (F-5.25, 2026-10-10; the author asked the chat to "delete everything in my
 * story bible" to start fresh and re-upload, and it organised instead). One chat edit removes
 * whole kinds at once: the sheets of chosen categories (threads are a category), the tags of
 * chosen tag categories (removing a tag takes it off its scenes; the scene text is never
 * touched), every Library upload, and the notes of every document. The chat's card lists each
 * kind the project has, with how many, ticked as the request named them; the author unticks what
 * stays, then Delete. Main takes a full backup first, removes everything in one transaction, and
 * logs one Changes row whose Undo puts it all back. Binder documents (scenes, chapters) are never
 * part of it: the manuscript is deleted one document at a time.
 */

export const CLEAR_GROUPS = ['sheets', 'tags', 'library', 'notes'] as const
export const ClearGroup = z.enum(CLEAR_GROUPS)
export type ClearGroup = z.infer<typeof ClearGroup>

/** The most items one card line lists (a category of sheets, the uploads, the documents with notes). */
export const CLEAR_IDS_MAX = 5_000

/**
 * One line of the card: a kind the project has, the items it covers (`ids`, as the card was
 * made: the author deletes exactly what they saw, never what was added since), how many, and
 * whether it goes.
 */
export const ClearOption = z.object({
  group: ClearGroup,
  /** The category id (sheets), the tag category (tags), or the group's own name (library, notes). */
  id: z.string().min(1).max(100),
  /** "Characters", "Tone tags", "Library uploads", "Notes". */
  label: z.string().min(1).max(200),
  count: z.number().int().min(1),
  ids: z.array(z.string().min(1)).min(1).max(CLEAR_IDS_MAX),
  checked: z.boolean()
})
export type ClearOption = z.infer<typeof ClearOption>

/** The card holds at most this many lines (the categories in use, seven tag categories, two more). */
export const CLEAR_OPTIONS_MAX = 60

/** The ticked items, as main deletes them: ids of sheets, tags, uploads, and documents whose notes go. */
const Ids = z.array(z.string().min(1)).max(CLEAR_IDS_MAX * CLEAR_OPTIONS_MAX)
export const ClearSelection = z.object({
  sheets: Ids,
  tags: Ids,
  library: Ids,
  notes: Ids
})
export type ClearSelection = z.infer<typeof ClearSelection>

/** The selection the ticked lines of a card make. */
export function clearSelectionOf(options: readonly ClearOption[]): ClearSelection {
  const ticked = (group: ClearGroup): string[] =>
    options.filter((o) => o.checked && o.group === group).flatMap((o) => o.ids)
  return {
    sheets: ticked('sheets'),
    tags: ticked('tags'),
    library: ticked('library'),
    notes: ticked('notes')
  }
}

/** Whether a selection names nothing at all. */
export function isEmptyClear(selection: ClearSelection): boolean {
  return CLEAR_GROUPS.every((group) => selection[group].length === 0)
}

/** "12 sheets, 30 tags, 3 uploads, notes of 5 documents": what a card's ticks remove. */
export function describeClearCounts(counts: ClearCounts): string {
  const parts: string[] = []
  const n = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  if (counts.sheets > 0) parts.push(n(counts.sheets, 'sheet', 'sheets'))
  if (counts.tags > 0) parts.push(n(counts.tags, 'tag', 'tags'))
  if (counts.library > 0) parts.push(n(counts.library, 'upload', 'uploads'))
  if (counts.notes > 0) parts.push(`the notes of ${n(counts.notes, 'document', 'documents')}`)
  return parts.length > 0 ? parts.join(', ') : 'nothing'
}

export const ClearCounts = z.object({
  sheets: z.number().int().min(0),
  tags: z.number().int().min(0),
  library: z.number().int().min(0),
  notes: z.number().int().min(0)
})
export type ClearCounts = z.infer<typeof ClearCounts>

/** The counts of the ticked lines (what the card's Delete button says it removes). */
export function tickedCounts(options: readonly ClearOption[]): ClearCounts {
  const counts: ClearCounts = { sheets: 0, tags: 0, library: 0, notes: 0 }
  for (const option of options) if (option.checked) counts[option.group] += option.count
  return counts
}

/**
 * What a clear removed, as main keeps it in the Changes row for its Undo: the rows themselves,
 * table by table (only the tables a clear deletes from or cascades into), the references other
 * rows held to them (cleared by `ON DELETE SET NULL` or by the tag delete path), the notes as they
 * were, and the merge aliases the tag delete dropped. Values are SQLite's own (text, numbers,
 * null), so the rows go back exactly as they were.
 */
export const CLEAR_TABLES = [
  'tag',
  'entity',
  'fact',
  'observed_fact',
  'continuity_finding',
  'document_tag',
  'document_tag_dismissal',
  'tag_mention',
  'context_file'
] as const
export const ClearTable = z.enum(CLEAR_TABLES)
export type ClearTable = z.infer<typeof ClearTable>

export const ClearValue = z.union([z.string(), z.number(), z.null()])
export type ClearValue = z.infer<typeof ClearValue>
export const ClearRow = z.record(z.string(), ClearValue)
export type ClearRow = z.infer<typeof ClearRow>

export const ClearSnapshot = z.object({
  rows: z.array(z.object({ table: ClearTable, rows: z.array(ClearRow) })),
  /** A surviving sheet's tag (and the aliases it had) that the tag delete cleared. */
  sheetTags: z.array(z.object({ id: z.string(), tagId: z.string(), aliases: z.string() })),
  /** A surviving tag's parent that went. */
  tagParents: z.array(z.object({ id: z.string(), parentId: z.string() })),
  /** Rows elsewhere that pointed at a deleted sheet (the Changes log, the To do list). */
  entityRefs: z.array(
    z.object({
      table: z.enum(['knowledge_change', 'todo_item']),
      id: z.string(),
      entityId: z.string()
    })
  ),
  /** Each cleared document's notes as stored (Tiptap JSON). */
  notes: z.array(z.object({ nodeId: z.string(), title: z.string(), notes: z.string() })),
  /** Merge aliases (F-4.9) that led to a deleted tag. */
  tagAliases: z.record(z.string(), z.string()),
  counts: ClearCounts
})
export type ClearSnapshot = z.infer<typeof ClearSnapshot>

/** The Changes line of a clear. */
export function clearLabel(counts: ClearCounts): string {
  return `Cleared ${describeClearCounts(counts)}`
}
