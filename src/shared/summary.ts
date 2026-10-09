import { z } from 'zod'
import { RelationType } from './relations'
import { AiSceneCard, SceneCard } from './sceneCard'
import { TAG_NAME_MAX, TagCategory } from './tags'
import { ThreadEvent, THREAD_NOTE_MAX } from './threads'

/**
 * Scene summaries (F-5.6): the derived index every Story Intelligence feature reads. A summary
 * is written in the background after the author pauses typing (main debounces the saves), is
 * invalidated by the content hash of what was sent (never by time, CLAUDE.md token rule 4),
 * and is stored in `scene_summary`, not as a proposal: nothing enters the manuscript and there
 * is no accept step, so its cost lives in the usage ledger alone. This file owns the limits and
 * the shapes both sides share; `src/main/ai/summarize.ts` is the use case and
 * `src/main/jobs/indexQueue.ts` (F-5.13) the debounce and the background runs.
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
/** Most observed facts kept from one scene (F-5.16): durable facts only, so a short list. */
export const SUMMARY_FACTS_MAX = 6
/** How many story-bible names occurring in the scene the prompt lists by kind (F-5.16). */
export const SUMMARY_KNOWN_NAMES_MAX = 40
/** Most tags the background job applies to one scene (F-4.13). */
export const SUMMARY_TAGS_MAX = 8
/** Most of those that may be new to the bank, so one scene cannot flood it. */
export const SUMMARY_NEW_TAGS_MAX = 3
/** How many tone, content, plot-thread, and custom bank names the prompt lists, most used first. */
export const SUMMARY_BANK_TAGS_MAX = 40
/**
 * The categories the job may create a tag in (F-4.13): names (which must occur in the scene),
 * tones, plot threads, and themes as `custom`. `content` holds content types the author
 * curates, so the job links those from the bank and never adds to them.
 */
export const AUTO_TAG_CATEGORIES = [
  'character',
  'setting',
  'worldBuilding',
  'tone',
  'plotThread',
  'custom'
] as const satisfies readonly TagCategory[]
/** The categories whose bank names the prompt lists; names of the other three ride `knownNames`. */
export const AUTO_TAG_BANK_CATEGORIES = [
  'tone',
  'content',
  'plotThread',
  'custom'
] as const satisfies readonly TagCategory[]
/** Most relationships kept from one scene (F-9.14, `summary.v4`). */
export const SUMMARY_RELATIONS_MAX = 4
/** Most thread events kept from one scene (F-9.14). */
export const SUMMARY_THREADS_MAX = 4
/** Most thread records one reading may create (F-9.14), so one scene cannot flood the Threads section. */
export const SUMMARY_NEW_THREADS_MAX = 2
/** Longest thread name the reading keeps. */
export const SUMMARY_THREAD_NAME_MAX = 60
/** Main waits this long after the last save of a scene before summarising it. */
export const SUMMARY_DEBOUNCE_MS = 3_000
/**
 * How long after the AI becomes able to run (a project opened, the dial or a toggle changed, a
 * key saved, an import) every scene without a current summary is queued: one pass for a burst.
 */
export const SUMMARY_BACKFILL_DELAY_MS = 5_000

/**
 * Whether a stored prompt version (`summary.v4`) is the build's own (`summary.v3`) or newer
 * (F-8.7). A summary written by a newer build stays current in an older one, which would
 * otherwise re-summarise, and pay for, every scene the newer build already did. Versions of
 * different prompts, or ones that are not `<name>.v<N>`, compare as not current.
 */
export function promptVersionAtLeast(stored: string, own: string): boolean {
  const a = PROMPT_VERSION.exec(stored)
  const b = PROMPT_VERSION.exec(own)
  if (a === null || b === null || a[1] !== b[1]) return false
  return Number(a[2]) >= Number(b[2])
}

const PROMPT_VERSION = /^(.+)\.v(\d+)$/

/** What the model answers and the pane shows: the summary, its key points, and the characters present. */
export const SceneSummary = z.object({
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS),
  keyPoints: z.array(z.string().min(1).max(SUMMARY_KEY_POINT_MAX)).max(SUMMARY_KEY_POINTS_MAX),
  characters: z.array(z.string().min(1).max(SUMMARY_CHARACTER_MAX)).max(SUMMARY_CHARACTERS_MAX)
})
export type SceneSummary = z.infer<typeof SceneSummary>

/** One tag of the model's answer (F-4.13), trimmed and checked; the name is not yet kebab-cased. */
export const ExtractedTag = z.object({
  name: z.string().min(1).max(TAG_NAME_MAX),
  category: TagCategory
})
export type ExtractedTag = z.infer<typeof ExtractedTag>

/**
 * One relationship of the model's answer (F-9.14), checked: both names are records the story bible
 * has (resolved later), the type is one of the list, and the quote is in the scene as sent.
 */
export const ExtractedRelation = z.object({
  from: z.string().min(1),
  type: RelationType,
  to: z.string().min(1),
  quote: z.string().min(1)
})
export type ExtractedRelation = z.infer<typeof ExtractedRelation>

/** One thread event of the model's answer (F-9.14), checked the same way; `question` may be ''. */
export const ExtractedThreadEvent = z.object({
  name: z.string().min(1).max(SUMMARY_THREAD_NAME_MAX),
  event: ThreadEvent,
  question: z.string().max(THREAD_NOTE_MAX),
  quote: z.string().min(1)
})
export type ExtractedThreadEvent = z.infer<typeof ExtractedThreadEvent>

/** A stored row: the summary plus what it was made from, so staleness is a hash comparison. */
export const StoredSceneSummary = SceneSummary.extend({
  nodeId: z.string(),
  /** sha256 over the scene text as sent, the metadata, and the bank names; differs → stale. */
  contentHash: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  /** Whether the scene was head-truncated to `SUMMARY_SCENE_CHAR_BUDGET` before it was sent. */
  truncated: z.boolean(),
  createdAt: z.string(),
  /**
   * F-9.14: the AI part of the scene card (`summary.v4` and later); absent or null for a row an
   * older prompt wrote, which carries none.
   */
  card: AiSceneCard.nullable().optional()
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
  error: z.object({ message: z.string(), nextStep: z.string() }).nullable(),
  /**
   * F-9.14: the scene card as main puts it together (the AI's reading, the author's metadata
   * winning, the cast from the mention index, the scene's thread events); null when it has
   * nothing to show, absent from an older main.
   */
  card: SceneCard.nullable().optional()
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
