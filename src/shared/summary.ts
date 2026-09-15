import { z } from 'zod'

/**
 * Scene summaries (F-5.6): the derived index every Story Intelligence feature reads. A summary
 * is written in the background after the author pauses typing (main debounces the saves), is
 * invalidated by the content hash of what was sent (never by time, CLAUDE.md token rule 4),
 * and is stored in `scene_summary`, not as a proposal: nothing enters the manuscript and there
 * is no accept step, so its cost lives in the usage ledger alone. This file owns the limits and
 * the shapes both sides share; `src/main/ai/summarize.ts` is the use case and
 * `src/main/ai/summaryScheduler.ts` the debounce.
 */

/** A scene shorter than this has nothing to summarise; a stored summary is dropped when it shrinks below. */
export const SUMMARY_TEXT_MIN = 200
/** The scene is head-truncated to this many characters before it is sent (one long scene, ~5,000 tokens). */
export const SUMMARY_SCENE_CHAR_BUDGET = 20_000
/** The summary itself, ~100 tokens; the model is asked for 80 words and the parser cuts here. */
export const SUMMARY_MAX_CHARS = 600
export const SUMMARY_KEY_POINTS_MAX = 4
export const SUMMARY_KEY_POINT_MAX = 140
export const SUMMARY_CHARACTERS_MAX = 8
export const SUMMARY_CHARACTER_MAX = 40
/** How many bank character names the prompt lists so the model spells them the author's way. */
export const SUMMARY_BANK_NAMES_MAX = 40
/** Main waits this long after the last save of a scene before summarising it. */
export const SUMMARY_DEBOUNCE_MS = 3_000

/** What the model answers and the pane shows: the summary, its key points, and the characters present. */
export const SceneSummary = z.object({
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS),
  keyPoints: z.array(z.string().min(1).max(SUMMARY_KEY_POINT_MAX)).max(SUMMARY_KEY_POINTS_MAX),
  characters: z.array(z.string().min(1).max(SUMMARY_CHARACTER_MAX)).max(SUMMARY_CHARACTERS_MAX)
})
export type SceneSummary = z.infer<typeof SceneSummary>

/** A stored row: the summary plus what it was made from, so staleness is a hash comparison. */
export const StoredSceneSummary = SceneSummary.extend({
  nodeId: z.string(),
  /** sha256 over the scene text as sent, the metadata, and the bank names; differs → stale. */
  contentHash: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  /** Whether the scene was head-truncated to `SUMMARY_SCENE_CHAR_BUDGET` before it was sent. */
  truncated: z.boolean(),
  createdAt: z.string()
})
export type StoredSceneSummary = z.infer<typeof StoredSceneSummary>

/** What main's scheduler knows about a node: nothing queued, a run in flight, or the last run failed. */
export const SummaryStatus = z.enum(['idle', 'pending', 'failed'])
export type SummaryStatus = z.infer<typeof SummaryStatus>

/**
 * What `summary:get` answers and `ai:summaryChanged` refreshes. `available` is false for any node
 * that is not a manuscript document (front and end matter, folders): the pane hides the block.
 * `stale` means the stored row was made from different text than the scene holds now (or there
 * is no row while the scene is long enough to have one). `error` carries the last background
 * failure with the next step, where the author can act on it.
 */
export const SceneSummaryState = z.object({
  available: z.boolean(),
  summary: StoredSceneSummary.nullable(),
  stale: z.boolean(),
  status: SummaryStatus,
  error: z.object({ message: z.string(), nextStep: z.string() }).nullable()
})
export type SceneSummaryState = z.infer<typeof SceneSummaryState>

/** The state of a node that cannot have a summary. */
export const UNAVAILABLE_SUMMARY: SceneSummaryState = {
  available: false,
  summary: null,
  stale: false,
  status: 'idle',
  error: null
}
