import { z } from 'zod'
import { AiErrorCode, type Tier } from './ai'
import { NotebookImportFile, NotebookItem } from './notebook'

/**
 * Sort with Ms Scribe (notes structure part B, `docs/research/notes-redesign-2026-10-15/structure.md`
 * §B, 2026-10-16): a document in Notes (a file just imported as one page, or a page already there)
 * broken into smaller pages in folders by `notesSort.v1`. Her pages copy the document's text: a
 * page with a line the document does not hold is dropped. The document itself is kept. One Undo
 * for the whole sort removes what it made and puts back the pages it appended to.
 */

/** The tier a sort goes out on (CLAUDE.md, token rule 1: classification and sorting are `fast`). */
export const NOTES_SORT_TIER: Tier = 'fast'

/** The most characters of a document one request carries (about 3,000 tokens). */
export const NOTES_SORT_CHUNK_CHARS = 12_000

/** The most characters of the Notes listing (folders and page titles) each request carries. */
export const NOTES_SORT_LIST_CHARS = 4_000

/** `max_tokens` of one request (`FEATURE_BUDGETS.notesSort`): the part's text copied, plus JSON. */
export const NOTES_SORT_MAX_TOKENS = 5_000

/** The most pages one answer may make; past it the rest are dropped. */
export const NOTES_SORT_PAGES_MAX = 30

/** The estimate's output per token of a part: her answer copies the part, with JSON around it. */
export const NOTES_SORT_OUTPUT_RATIO = 1.1

/** What a sort would send (the price shown before it starts). */
export const NotesSortEstimate = z.object({
  /** Documents with text. */
  sources: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative()
})
export type NotesSortEstimate = z.infer<typeof NotesSortEstimate>

/**
 * What `notesSort:estimate` prices: note pages already in Notes, or files not imported yet
 * (dropped, as bytes, or picked, as paths) read as the import would read them.
 */
export const NotesSortEstimateInput = z.object({
  pageIds: z.array(z.string()).min(1).optional(),
  files: z.array(NotebookImportFile).min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional()
})
export type NotesSortEstimateInput = z.infer<typeof NotesSortEstimateInput>

/** A page the sort appended to, with the version kept before its first append (its Undo). */
export const NotesSortAppended = z.object({
  pageId: z.string(),
  versionId: z.string(),
  title: z.string()
})
export type NotesSortAppended = z.infer<typeof NotesSortAppended>

/**
 * A finished sort: the folders and pages it made (in the order made), the pages it appended to,
 * how many pages it wrote in all (made and appended, each once), the pages dropped (a line not in
 * the document, no title or text, past the cap), the parts whose answer could not be read (or
 * were not sent after a stop), and why it stopped early. Or an expected AI failure as data, with
 * nothing written.
 */
export const NotesSortRunResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    made: z.array(NotebookItem),
    appended: z.array(NotesSortAppended),
    pages: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    /** Why the sort stopped early (a provider error after a part was written), else null. */
    stopped: z.string().nullable()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string()
  })
])
export type NotesSortRunResult = z.infer<typeof NotesSortRunResult>
