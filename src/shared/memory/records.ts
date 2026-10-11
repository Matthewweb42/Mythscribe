import { z } from 'zod'
import { ALIAS_MAX, ALIASES_MAX } from '../aliases'
import { ENTITY_NAME_MAX } from '../entities'
import { TiptapNode } from '../tiptap'

/**
 * Records (F-16.4, story memory v2): what names and nicknames point at. A record replaces both
 * the v1 tag and the v1 sheet: it has a category (built-in or the author's own, kept as in v1),
 * a kind that follows the category, an image, the author's **Pinned** page (canon) and **Ideas**
 * page (never treated as true), and its names in `alias` (one of them `is_main`: the record's
 * name, so a name has a single owner, decision P1-D2).
 */

export const RECORD_KINDS = [
  'character',
  'place',
  'thing',
  'group',
  'term',
  'secret',
  'thread'
] as const
export const RecordKind = z.enum(RECORD_KINDS)
export type RecordKind = z.infer<typeof RecordKind>

/** Built-in categories whose kind is not `thing`; every other one, custom ones included, is a thing. */
const KIND_OF_CATEGORY: Readonly<Record<string, RecordKind>> = {
  character: 'character',
  setting: 'place',
  faction: 'group',
  thread: 'thread',
  magic: 'term',
  religion: 'term',
  culture: 'term',
  history: 'term',
  language: 'term',
  technology: 'term',
  lore: 'term'
}

/**
 * The kind a record of `categoryId` has: character → character; setting → place; faction →
 * group; thread → thread; magic, religion, culture, history, language, technology and lore →
 * term; world, item, creature and every custom (`c-…`) category → thing. Secrets come from P2b's
 * who-knows-what, never from a category.
 */
export function recordKindOf(categoryId: string): RecordKind {
  return KIND_OF_CATEGORY[categoryId] ?? 'thing'
}

/** Who made a record. `ai` is reserved for P2a's reader; nothing writes it in P1. */
export const RECORD_ORIGINS = ['author', 'conversion', 'filed', 'chat', 'ai'] as const
export const RecordOrigin = z.enum(RECORD_ORIGINS)
export type RecordOrigin = z.infer<typeof RecordOrigin>

/** Who added a name: the author, the switch-over, a Yes to a nickname question, filing, the reader. */
export const ALIAS_ORIGINS = ['author', 'conversion', 'confirmed', 'filed', 'ai'] as const
export const AliasOrigin = z.enum(ALIAS_ORIGINS)
export type AliasOrigin = z.infer<typeof AliasOrigin>

/**
 * How a name is matched in the prose (identity rule 3). `auto`: as a capitalised name, and in its
 * exact case only when the scene also writes it in lower case ("Will" beside "will"); `exact`:
 * always in its exact case (titles the author added, "the Captain"); `any`: in any case on word
 * boundaries (a name the author typed in lower case).
 */
export const CASE_RULES = ['auto', 'exact', 'any'] as const
export const CaseRule = z.enum(CASE_RULES)
export type CaseRule = z.infer<typeof CaseRule>

/** The longest record name (its main alias), as long as a v1 sheet name. */
export const RECORD_NAME_MAX = ENTITY_NAME_MAX
/** The longest other name, as long as a v1 alias. */
export const RECORD_ALIAS_MAX = ALIAS_MAX
/** Most names one record keeps besides its main name. */
export const RECORD_ALIASES_MAX = ALIASES_MAX

export const RecordAlias = z.object({
  id: z.string(),
  recordId: z.string(),
  /** As the author spells it, trimmed. */
  text: z.string(),
  /** `normName(text)`: what names are compared and looked up by. */
  norm: z.string(),
  /** The record's name; exactly one per record. */
  isMain: z.boolean(),
  caseRule: CaseRule,
  origin: AliasOrigin,
  /** Several records may hold this norm only when every one of them marks it shared (rule 4). */
  shared: z.boolean(),
  created: z.string()
})
export type RecordAlias = z.infer<typeof RecordAlias>

/** A record as lists show it: everything but its two pages. */
export const StoryRecordSummary = z.object({
  id: z.string(),
  /** A library category id or the project's own `c-…` id, by value (no foreign key). */
  categoryId: z.string(),
  kind: RecordKind,
  /** The main alias's text. */
  name: z.string(),
  /** File name under the project's `assets/entities/`; null when there is none. */
  image: z.string().nullable(),
  origin: RecordOrigin,
  /** Every name, the main one first, the rest in the order they were added. */
  aliases: z.array(RecordAlias),
  created: z.string(),
  modified: z.string()
})
export type StoryRecordSummary = z.infer<typeof StoryRecordSummary>

/** A record with its Pinned and Ideas pages (Tiptap JSON; null while empty). */
export const StoryRecord = StoryRecordSummary.extend({
  pinned: TiptapNode.nullable(),
  ideas: TiptapNode.nullable()
})
export type StoryRecord = z.infer<typeof StoryRecord>

export const RECORD_PAGES = ['pinned', 'ideas'] as const
export const RecordPage = z.enum(RECORD_PAGES)
export type RecordPage = z.infer<typeof RecordPage>

/** A record's name as a channel accepts it. */
export const RecordName = z.string().trim().min(1).max(RECORD_NAME_MAX)

/** The record's own name as `record:setAliases` takes it. */
export const RecordMainNameInput = z.object({
  text: RecordName,
  caseRule: CaseRule.optional(),
  shared: z.boolean().default(false)
})

/** One other name as `record:setAliases` takes it. */
export const RecordAliasInput = z.object({
  text: z.string().trim().min(1).max(RECORD_ALIAS_MAX),
  /** Left out: `any` for a name typed without a capital letter, `auto` otherwise. */
  caseRule: CaseRule.optional(),
  shared: z.boolean().default(false)
})
export type RecordAliasInput = z.input<typeof RecordAliasInput>

/** The case rule a name gets when nobody chose one: `any` without a capital letter, else `auto`. */
export function defaultCaseRule(text: string): CaseRule {
  return /[\p{Lu}\p{Lt}]/u.test(text) ? 'auto' : 'any'
}
