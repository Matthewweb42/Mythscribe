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
    factsImportedAt: z.string().default('')
  })
  .loose()
export type KnowledgeModelState = z.infer<typeof KnowledgeModelState>

/** The version of F-9.12's conversion; a project whose `index` is below it is converted on open. */
export const KNOWLEDGE_INDEX_VERSION = 1

/** The version of F-9.13's fact conversion; a project whose `facts` is below it is converted on open. */
export const KNOWLEDGE_FACTS_VERSION = 1

/**
 * The tag categories whose tags name a thing and so get a record (decision D8), and the story-
 * bible category that record goes in. Plot threads get theirs with the thread category (a later
 * phase); tone, content, and custom tags stay labels.
 */
export const RECORD_KIND_FOR_TAG: Partial<Record<TagCategory, EntityKind>> = {
  character: 'character',
  setting: 'setting',
  worldBuilding: 'world'
}

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
