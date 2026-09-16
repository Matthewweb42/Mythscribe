import { z } from 'zod'

/**
 * The beta reader (F-14.11): a read-through of the manuscript up to a scene as a first-time
 * reader, reported as what the reader knows, believes, and expects, where they were confused,
 * and which threads went quiet. The reader reads every earlier manuscript scene through its
 * stored summary and key points (F-5.6, in reading order) and the scene itself in full, and
 * knows nothing else: no story bible, no voice profile, no brief, so the report says what the
 * page alone conveys. Every item cites a passage from a named scene, matched with the rules
 * `src/shared/critique.ts` owns (F-14.8's citation rule); an item whose quote is not in the
 * scene it names is dropped. The honesty setting is the editor's (`AiSettings.critique`).
 * A reader reports; it never proposes a fix (that is the editor's job, F-14.8).
 */

/** What a report item is about, in the order the panel groups them. */
export const BETA_READER_CATEGORIES = [
  'knows',
  'believes',
  'expects',
  'confusion',
  'droppedThread'
] as const
export const BetaReaderCategory = z.enum(BETA_READER_CATEGORIES)
export type BetaReaderCategory = z.infer<typeof BetaReaderCategory>

export const BETA_READER_CATEGORY_LABEL: Record<BetaReaderCategory, string> = {
  knows: 'Knows',
  believes: 'Believes',
  expects: 'Expects',
  confusion: 'Confused',
  droppedThread: 'Dropped thread'
}

/** Characters of scene text a document needs before the reader can read up to it. */
export const BETA_READER_TEXT_MIN = 200
/** The scene itself is head-truncated to this many characters (~5,000 tokens) before it is sent. */
export const BETA_READER_SCENE_CHAR_BUDGET = 20_000
/** When the prompt is over budget the scene is shrunk this much at a time (token rule 8)… */
export const BETA_READER_SHRINK_CHARS = 2_000
/** …down to this floor; after that the farthest earlier scenes are dropped instead. */
export const BETA_READER_SCENE_CHAR_FLOOR = 4_000
/** Items per report, after the uncited ones are dropped. */
export const BETA_READER_MAX_ITEMS = 12
export const BETA_READER_QUOTE_MAX = 240
export const BETA_READER_NOTE_MAX = 300

/**
 * One report item as the renderer receives it: `scene` is the 1-based number of the scene in
 * the list main sent (`BetaReaderScene[]`, the current scene last), and `quote` is a passage
 * main found in that scene's text as sent (the scene text itself for the current scene, the
 * summary and key points for an earlier one).
 */
export const BetaReaderItem = z.object({
  category: BetaReaderCategory,
  scene: z.number().int().min(1),
  quote: z.string().min(1).max(BETA_READER_QUOTE_MAX),
  note: z.string().min(1).max(BETA_READER_NOTE_MAX)
})
export type BetaReaderItem = z.infer<typeof BetaReaderItem>
export const BetaReaderItems = z.array(BetaReaderItem).max(BETA_READER_MAX_ITEMS)
export type BetaReaderItems = z.infer<typeof BetaReaderItems>

/** A scene the reader read, in the order sent; `current` marks the scene read in full (always last). */
export const BetaReaderScene = z.object({
  nodeId: z.string(),
  /** The document's title, prefixed with its chapter's when it sits under one (`Chapter 1 › The Ferry`). */
  title: z.string(),
  current: z.boolean()
})
export type BetaReaderScene = z.infer<typeof BetaReaderScene>
