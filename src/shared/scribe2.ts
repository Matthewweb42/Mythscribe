import { z } from 'zod'
import type { AssistantMode } from './aiSettings'

/**
 * Ms Scribe in a story memory v1 project (notes redesign phase 1, 2026-10-15,
 * `docs/research/notes-redesign-2026-10-15/plan.md` "How Ms Scribe gets the right context"): she
 * answers with every note page, the book map and the book (whole when it fits) in view, looks
 * further with tools, edits and creates note pages directly (each with Undo), and suggests prose
 * changes the author accepts. Named `scribe2` in code beside story memory v2's `scribe`.
 */

/** Under this many estimated tokens for the whole request, the whole book goes along. */
export const SCRIBE_WHOLE_BOOK_TOKENS = 60_000
/** The book's share when it does not fit whole: the scenes picked for the question. */
export const SCRIBE_PICK_BOOK_TOKENS = 24_000
/** The most of the book "Whole book" sends; scenes past it are listed as left out. */
export const SCRIBE_FORCED_BOOK_TOKENS = 80_000
/** Every note page goes along up to this; past it, the list and the pages that match. */
export const SCRIBE_NOTES_TOKENS = 30_000
/** Folders with a template the notes block lists (notes fixes, 2026-10-15); the rest are left out. */
export const SCRIBE_TEMPLATE_FOLDERS_MAX = 20
/** Headings one listed template names; an author's longer template is cut with "…". */
export const SCRIBE_TEMPLATE_SECTIONS_MAX = 20
/** A scene's notes in the book map are cut to this many characters (the moment has them whole). */
export const SCRIBE_MAP_NOTES_CHARS = 600
/** A scene's synopsis or summary in the book map is cut to this many characters. */
export const SCRIBE_MAP_SYNOPSIS_CHARS = 600
/** The open scene's notes in the moment are cut to this many characters. */
export const SCRIBE_MOMENT_NOTES_CHARS = 4_000
/** Characters one `open_scene` or `open_note` call returns; she reads on with `from`. */
export const SCRIBE_READ_CHARS = 12_000
/** Passages one `search_book` call names. */
export const SCRIBE_SEARCH_RESULTS = 8
/** Tool calls per message before she must answer. */
export const SCRIBE_MAX_STEPS = 6
/** What one message may spend across its steps; past it she must answer at once. */
export const SCRIBE_COST_CAP_USD = 0.5
/** The `max_tokens` one step asks for (an `edit_note` may carry a page). */
export const SCRIBE_STEP_MAX_TOKENS = 3_000
/** The one retry of a reply cut off or unreadable asks for this (`outputBudget('scribe')`). */
export const SCRIBE_RETRY_MAX_TOKENS = 6_000
/** Note writes and prose suggestions one message may make; past it a write tool refuses. */
export const SCRIBE_MAX_WRITES = 8
/**
 * Prose suggestions one Vibe answer may make (`scribe.v3`, 2026-10-15, decided by Claude): she
 * proposes changes unasked there, so past this a further `propose_prose_edit` is refused.
 */
export const SCRIBE_VIBE_PROSE_MAX = 3

/** The prose suggestions one message in `mode` may make: three in Vibe, else the write cap. */
export function scribeProseMax(mode: AssistantMode): number {
  return mode === 'vibe' ? SCRIBE_VIBE_PROSE_MAX : SCRIBE_MAX_WRITES
}

/** The longest text one note write may carry. */
export const SCRIBE_NOTE_TEXT_MAX = 12_000
/** How much of a page before and after an edit the chat keeps, for its highlight. */
export const SCRIBE_DIFF_CHARS = 2_000
/** Sources kept per answer. */
export const SCRIBE_SOURCES_MAX = 12
/** Passages one source keeps (`scribe.v2`: the exact words she relied on, checked by main). */
export const SCRIBE_SOURCE_QUOTES_MAX = 3
/** The longest quote a source keeps; a longer one is not kept. */
export const SCRIBE_QUOTE_MAX = 400
/** The shortest quote a source keeps (once normalized), so a stray word never stands for a spot. */
export const SCRIBE_QUOTE_MIN = 8

/** The tools `scribe.v1` names. */
export const SCRIBE_READ_TOOLS = ['search_book', 'open_scene', 'list_notes', 'open_note'] as const
export const SCRIBE_NOTE_TOOLS = ['edit_note', 'create_note'] as const
export const SCRIBE_PROSE_TOOLS = ['propose_prose_edit'] as const
/**
 * The structure tools `scribe.v5` names (notes structure part C, 2026-10-16): Notes folders and
 * pages made, moved, renamed and deleted in main at once (deletions ask), and the manuscript's
 * chapters and scenes through the chat agent's own tree edits, applied by the chat with Undo.
 */
export const SCRIBE_NOTES_STRUCTURE_TOOLS = [
  'create_folder',
  'move_note',
  'rename_note',
  'delete_note'
] as const
export const SCRIBE_BOOK_STRUCTURE_TOOLS = [
  'create_chapter',
  'create_scene',
  'move_scene',
  'rename_scene',
  'split_scene',
  'merge_scenes',
  'delete_scene'
] as const
export const SCRIBE_STRUCTURE_TOOLS = [
  ...SCRIBE_NOTES_STRUCTURE_TOOLS,
  ...SCRIBE_BOOK_STRUCTURE_TOOLS
] as const
export const SCRIBE_TOOLS = [
  ...SCRIBE_READ_TOOLS,
  ...SCRIBE_NOTE_TOOLS,
  ...SCRIBE_PROSE_TOOLS,
  ...SCRIBE_STRUCTURE_TOOLS
] as const
export type ScribeTool = (typeof SCRIBE_TOOLS)[number]

/**
 * Structure changes one message may make (`scribe.v5`, decided by Claude: 40), each item moved
 * counted; apart from `SCRIBE_MAX_WRITES`, which counts note writes and prose suggestions.
 */
export const SCRIBE_MAX_STRUCTURE = 40

/** What a message may write: note pages, prose suggestions, structure (folders, chapters, scenes). */
export interface ScribeAccess {
  notes: boolean
  prose: boolean
  /** `scribe.v5`'s structure tools; left out (the edit flow's notes run), none. */
  structure?: boolean
}

/**
 * "Save that", "put it in Mara's page", "add this to the timeline", "write that down", "note
 * that": the author asking Brainstorm to keep what was said.
 */
const SAVE_REQUEST = new RegExp(
  [
    String.raw`\b(save|keep|jot|store)\b[^.?!\n]{0,30}\b(that|this|it|these|those|them|down)\b`,
    String.raw`\bput (that|this|it|these|those|them)\b`,
    String.raw`\b(add|write|file) (that|this|it|these|those|them)\b[^.?!\n]{0,30}\b(to|in|into|down)\b`,
    String.raw`\bnote (that|this|it) down\b`,
    String.raw`\bupdate (my|the) notes?\b`
  ].join('|'),
  'i'
)

/** Whether a Brainstorm message asks her to keep something in the notes. */
export function wantsSave(message: string): boolean {
  return SAVE_REQUEST.test(message)
}

/**
 * What a message may write in `mode` (the author's decision of 2026-10-15): Brainstorm writes
 * nothing unless the message asks her to save, and then only note pages, never structure; Write
 * and Vibe edit notes, suggest prose and change the structure (2026-10-16).
 */
export function scribeAccess(mode: AssistantMode, message: string): ScribeAccess {
  if (mode === 'brainstorm') return { notes: wantsSave(message), prose: false, structure: false }
  return { notes: true, prose: true, structure: true }
}

/** A page source's kind: a note page, a story-bible sheet, a Library upload (until phase 4). */
export const SCRIBE_PAGE_KINDS = ['note', 'sheet', 'library'] as const
export const ScribePageKind = z.enum(SCRIBE_PAGE_KINDS)
export type ScribePageKind = z.infer<typeof ScribePageKind>

/**
 * The passages a source rests on (`scribe.v2`), each found in the scene or page by main and kept
 * as it stands there once normalized (`normalizeForMatch`), so the renderer's `locateText` finds
 * it; a source she gave no quote for, or none that was found, has none. Older answers have none.
 */
const SourceQuotes = z
  .array(z.string().max(SCRIBE_QUOTE_MAX))
  .max(SCRIBE_SOURCE_QUOTES_MAX)
  .default([])

/**
 * The scenes and pages an answer used, under it, each opening where it is (at its first quote).
 * A scene's `title` is `Chapter › Scene`, or the scene's own title outside a chapter.
 */
export const ScribeSources = z.object({
  scenes: z
    .array(z.object({ nodeId: z.string(), title: z.string(), quotes: SourceQuotes }))
    .max(SCRIBE_SOURCES_MAX),
  pages: z
    .array(
      z.object({ id: z.string(), title: z.string(), kind: ScribePageKind, quotes: SourceQuotes })
    )
    .max(SCRIBE_SOURCES_MAX)
})
export type ScribeSources = z.infer<typeof ScribeSources>
