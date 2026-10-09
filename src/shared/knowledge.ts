import { z } from 'zod'
import type { EntityKind } from './entities'
import type { TagCategory } from './tags'

/**
 * The knowledge model (plan `plan-knowledge-model.md`, milestone M7). F-9.12, the local
 * knowledge index: every name tag points at one record (a story-bible sheet), and the mention
 * scan doubles as a local full-text index of the manuscript. Nothing here is AI: it is local,
 * free, and never edits scene text.
 */

/**
 * The project's conversion state, a `settings` row: which steps of the knowledge model have run
 * on this project. `index` is F-9.12's one-time pass (every name tag gets a record, every record
 * a tag). Keys a later build adds are kept when this one writes the row.
 */
export const KNOWLEDGE_MODEL_KEY = 'knowledgeModel'
export const KnowledgeModelState = z
  .object({
    index: z.number().int().nonnegative().default(0),
    /** F-9.13's conversion: the old observed facts copied into `fact`, the sheets' text into author facts. */
    facts: z.number().int().nonnegative().default(0),
    /**
     * The newest `observed_fact.created_at` already copied. An older build still writes that
     * table (decision D9 keeps it), so every open copies the rows written after this.
     */
    factsImportedAt: z.string().default(''),
    /** F-9.14: the plot-thread tags the author made got their thread records. */
    threads: z.number().int().nonnegative().default(0),
    /**
     * F-9.14's conversion pass: the version the author confirmed ("Update now") re-reading every
     * scene with the newer summary prompt (scene cards, relationships, threads). Below
     * `KNOWLEDGE_CARDS_VERSION`, a scene whose summary is out of date only because an older
     * prompt wrote it is held back from the background pass until the author confirms the cost.
     */
    cards: z.number().int().nonnegative().default(0)
  })
  .loose()
export type KnowledgeModelState = z.infer<typeof KnowledgeModelState>

/** The version of F-9.12's conversion; a project whose `index` is below it is converted on open. */
export const KNOWLEDGE_INDEX_VERSION = 1

/** The version of F-9.13's fact conversion; a project whose `facts` is below it is converted on open. */
export const KNOWLEDGE_FACTS_VERSION = 1

/** The version of F-9.14's thread-record pass; a project whose `threads` is below it gets it on open. */
export const KNOWLEDGE_THREADS_VERSION = 1

/** The version of F-9.14's conversion pass (summary.v4: cards, relationships, threads). */
export const KNOWLEDGE_CARDS_VERSION = 1

/**
 * The tag categories whose tags name a thing and so get a record (decision D8), and the story-
 * bible category that record goes in: plot threads get theirs in the thread category (F-9.14);
 * tone, content, and custom tags stay labels.
 */
export const RECORD_KIND_FOR_TAG: Partial<Record<TagCategory, EntityKind>> = {
  character: 'character',
  setting: 'setting',
  worldBuilding: 'world',
  plotThread: 'thread'
}

/**
 * Where the conversion pass stands (F-9.14, D11), as `knowledge:conversion` answers it:
 * - `none`: nothing to ask (no scene waits on it, or the AI cannot run: Use AI off, scene
 *   summaries off, no provider set up);
 * - `pending`: scenes wait for the author's go-ahead; the dialog shows unless `deferred`;
 * - `done`: the author confirmed it; the background pass re-reads the scenes as usual.
 */
export const KnowledgeConversionState = z.enum(['none', 'pending', 'done'])
export type KnowledgeConversionState = z.infer<typeof KnowledgeConversionState>

export const KnowledgeConversion = z.object({
  state: KnowledgeConversionState,
  /** The scenes the pass would re-read now. */
  scenes: z.number().int().nonnegative(),
  /** The estimated cost in USD on the configured model; 0 on a local model. */
  costUsd: z.number().nonnegative(),
  /** False when the model is not in the price table (the cost is then unknown, not free). */
  priced: z.boolean(),
  /** The fast tier's model, or '' while no AI source is set up. */
  model: z.string(),
  source: z.enum(['ownKey', 'cloud', 'local']),
  /** The estimated time in whole minutes (at least 1 when there is anything to do). */
  minutes: z.number().int().nonnegative(),
  /** The author chose Later in this session: the dialog stays closed until the next open. */
  deferred: z.boolean()
})
export type KnowledgeConversion = z.infer<typeof KnowledgeConversion>

/**
 * How long one scene's reading is estimated to take, for the dialog's time: the index queue runs
 * one job at a time, and a fast-tier JSON answer of about 600 tokens takes a few seconds.
 */
export const CONVERSION_SECONDS_PER_SCENE = 8

/** Where "Make a record" files a tag of a category that has no record kind of its own. */
export const RECORD_KIND_FALLBACK: EntityKind = 'world'

/** The record name for a tag: its words, each opening with a capital ("rose-marsh" → "Rose Marsh"). */
export function recordNameForTag(tagName: string): string {
  return tagName
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(' ')
}
