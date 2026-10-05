import { z } from 'zod'

/**
 * Drafts (F-8.5): named versions of the manuscript's text inside one project. Every draft shares
 * the one tree (titles, notes, scene metadata, tags); only the text of manuscript documents
 * differs. The active draft's text is the live `node.content`; an inactive draft keeps its own
 * text per document in `draft_text`, and a document with no row there shows its live text
 * (a scene added after the draft was left reads the same in it until it is edited there).
 */

export const DRAFT_NAME_MAX = 60

/** The name a project's first draft gets when drafts are first used. */
export const FIRST_DRAFT_NAME = 'Draft 1'

export const DraftName = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(DRAFT_NAME_MAX))

export const DraftInfo = z.object({
  id: z.string(),
  name: z.string(),
  /** Words over the manuscript documents as this draft reads them. */
  wordCount: z.number().int().nonnegative(),
  active: z.boolean(),
  created: z.string(),
  modified: z.string()
})
export type DraftInfo = z.infer<typeof DraftInfo>

/** Every draft of the open project in list order (oldest first); exactly one is active. */
export const DraftList = z.object({
  drafts: z.array(DraftInfo),
  activeId: z.string()
})
export type DraftList = z.infer<typeof DraftList>

/** One run of a word-level diff; `text` keeps its whitespace so the runs join back verbatim. */
export const DIFF_OPS = ['same', 'add', 'del'] as const
export const DiffSegment = z.object({
  op: z.enum(DIFF_OPS),
  text: z.string()
})
export type DiffSegment = z.infer<typeof DiffSegment>

/** A manuscript document whose text differs between the two compared drafts. */
export const DraftDocDiff = z.object({
  nodeId: z.string(),
  title: z.string(),
  /** Ancestor titles below the section, outermost first ("Part One › Chapter 2"). */
  path: z.array(z.string()),
  /** From `from` to `to`: `del` is only in `from`, `add` only in `to`. */
  segments: z.array(DiffSegment),
  wordsAdded: z.number().int().nonnegative(),
  wordsRemoved: z.number().int().nonnegative()
})
export type DraftDocDiff = z.infer<typeof DraftDocDiff>

export const DraftComparison = z.object({
  fromId: z.string(),
  toId: z.string(),
  /** Changed documents in manuscript (tree) order; unchanged ones are left out. */
  docs: z.array(DraftDocDiff),
  /** How many manuscript documents read the same in both drafts. */
  unchanged: z.number().int().nonnegative()
})
export type DraftComparison = z.infer<typeof DraftComparison>

/** What a switch or a revert rewrote in the live manuscript, so the renderer can refresh it. */
export const DraftChange = z.object({
  list: DraftList,
  changed: z.array(z.object({ id: z.string(), wordCount: z.number().int().nonnegative() }))
})
export type DraftChange = z.infer<typeof DraftChange>
