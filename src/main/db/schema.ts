import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
// Relative on purpose: drizzle-kit loads this file without the `@shared` path alias.
import { AI_PROVIDER_IDS } from '../../shared/ai'
import {
  CONTINUITY_ORIGINS,
  CONTINUITY_REF_KINDS,
  CONTINUITY_STATUSES
} from '../../shared/continuity'
import {
  DEVELOPMENTAL_CATEGORIES,
  EDIT_CHANGE_KINDS,
  EDIT_CHANGE_STATUSES,
  EDIT_PASS_STATUSES,
  EDIT_PASS_TYPES
} from '../../shared/editPass'
import { EDIT_FLOW_CATEGORIES } from '../../shared/editFlow'
import { CONTEXT_FILE_TYPES } from '../../shared/contextLibrary'
import { CATEGORY_ICONS, CATEGORY_ORIGINS } from '../../shared/categories'
import { ENTITY_ORIGINS, ENTITY_TEMPLATES } from '../../shared/entities'
import { FACT_ORIGINS, FACT_STATUSES } from '../../shared/facts'
import { CHANGE_KINDS, CHANGE_STATUSES } from '../../shared/changes'
import { NOTEBOOK_AUTHORS, NOTEBOOK_KINDS } from '../../shared/notebook'
import { PROPOSAL_STATUSES } from '../../shared/proposal'
import { HIERARCHY_LEVELS, NODE_KINDS, SECTION_TYPES } from '../../shared/labels'
import { SNAPSHOT_KINDS, SNAPSHOT_SCOPES } from '../../shared/snapshots'
import { TAG_CATEGORIES } from '../../shared/tags'
import { TODO_KINDS, TODO_RULES, TODO_SOURCES, TODO_STATUSES } from '../../shared/todo'
import { EXEMPLAR_KINDS, VOICE_EXEMPLAR_SOURCES } from '../../shared/voice'
import { ALIAS_ORIGINS, CASE_RULES, RECORD_ORIGINS } from '../../shared/memory/records'
import { DISMISSED_KINDS } from '../../shared/memory/dismissed'
import { MEMORY_OWNER_KINDS } from '../../shared/memory/passages'
import {
  BACKFILL_STATES,
  CLAIM_MODES,
  CLAIM_PROOFS,
  CLAIM_STATES,
  CLAIM_VOICES,
  PLAN_LINK_ORIGINS,
  READING_PURPOSES,
  SPOT_TIERS,
  SPOT_VERDICTS,
  TOPIC_QUOTE_ROLES,
  TOPIC_QUOTE_STATES
} from '../../shared/memory/claims'
import {
  FINDING_RULES,
  FINDING_STATES,
  FINDING_VARIANTS,
  JUDGE_VERDICTS
} from '../../shared/memory/findings'
import { LABEL_KINDS } from '../../shared/storyLabels'
import { RESEARCH_ORIGINS } from '../../shared/research'

/**
 * Drizzle schema. Migrations are generated from this file with `npm run db:generate`
 * into ./migrations and applied by ./migrate.ts. Never edit a shipped migration.
 */

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  format: text('format', { enum: ['novel', 'epic', 'webnovel'] })
    .notNull()
    .default('novel'),
  created: text('created').notNull(),
  modified: text('modified').notNull(),
  lastOpened: text('last_opened').notNull()
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

/**
 * Document tree (FEATURES.md §1). The three roots (parent_id NULL) are the sections and are
 * the only rows with a section_type; everything else hangs under one of them.
 */
export const node = sqliteTable(
  'node',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => node.id, {
      onDelete: 'cascade'
    }),
    /** Non-null only on the three root sections. */
    sectionType: text('section_type', { enum: SECTION_TYPES }),
    kind: text('kind', { enum: NODE_KINDS }).notNull(),
    /** null = generic node or section. */
    hierarchyLevel: text('hierarchy_level', { enum: HIERARCHY_LEVELS }),
    title: text('title').notNull(),
    /** 0-based, contiguous among siblings. */
    position: integer('position').notNull(),
    /** Tiptap JSON string; null = empty. */
    content: text('content'),
    notes: text('notes'),
    wordCount: integer('word_count').notNull().default(0),
    /** JSON: location, POV, timeline position, free-form. */
    sceneMeta: text('scene_meta'),
    matterType: text('matter_type'),
    preset: text('preset'),
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [
    index('node_parent_position_idx').on(t.parentId, t.position),
    uniqueIndex('node_section_type_uq').on(t.sectionType),
    check('node_root_is_section', sql`(${t.parentId} IS NULL) = (${t.sectionType} IS NOT NULL)`)
  ]
)
export type NodeRow = typeof node.$inferSelect
export type NodeInsert = typeof node.$inferInsert

/**
 * Tag bank (F-4.1). Names are kebab-case and unique across the project; `parent_id` nests a tag
 * under another and is cleared (not cascaded) when the parent goes. Usage counts are derived
 * from `document_tag`, never stored here.
 */
export const tag = sqliteTable(
  'tag',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    category: text('category', { enum: TAG_CATEGORIES }).notNull(),
    /** Lowercase `#rrggbb`. */
    color: text('color').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => tag.id, {
      onDelete: 'set null'
    }),
    /** F-4.12: whether the automatic mention scan looks for this name; on for every new tag. */
    trackMentions: integer('track_mentions', { mode: 'boolean' }).notNull().default(true),
    /**
     * F-4.13: `ai` only while the background tagging job made the tag and the author has not
     * edited it; deleting such a tag records its name so the job does not make it again.
     */
    origin: text('origin', { enum: ['author', 'ai'] })
      .notNull()
      .default('author'),
    /** F-4.14: JSON array of the tag's other names (nicknames, titles), as the author typed them. */
    aliases: text('aliases').notNull().default('[]'),
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [uniqueIndex('tag_name_uq').on(t.name)]
)
export type TagRow = typeof tag.$inferSelect
export type TagInsert = typeof tag.$inferInsert

/** A tag applied to a document (F-4.4, F-4.6 write it); both ends cascade on delete. */
export const documentTag = sqliteTable(
  'document_tag',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    /** F-4.13: `ai` for a link the background tagging job applied; the author's own are `author`. */
    source: text('source', { enum: ['author', 'ai'] })
      .notNull()
      .default('author'),
    created: text('created').notNull()
  },
  (t) => [
    uniqueIndex('document_tag_node_tag_uq').on(t.nodeId, t.tagId),
    index('document_tag_tag_idx').on(t.tagId)
  ]
)
export type DocumentTagRow = typeof documentTag.$inferSelect
export type DocumentTagInsert = typeof documentTag.$inferInsert

/**
 * A tag the author took off a node (F-4.13): the background tagging job never applies that tag
 * to that node again. The author linking it again lifts it; both ends cascade on delete.
 */
export const documentTagDismissal = sqliteTable(
  'document_tag_dismissal',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.tagId] })]
)

/**
 * One row per completed AI request (F-5.14). Written after the provider answers, or after a
 * cache hit (`cached` true, cost 0, the cached usage so token totals stay honest). Refusals
 * (BUDGET) and provider failures are never logged: nothing was spent.
 */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    /** ISO timestamp. */
    at: text('at').notNull(),
    /** An `AiFeature`. */
    feature: text('feature').notNull(),
    tier: text('tier', { enum: ['fast', 'strong'] }).notNull(),
    model: text('model').notNull(),
    provider: text('provider', { enum: AI_PROVIDER_IDS }).notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    /** null when the provider does not report prompt-cache hits. */
    cachedTokens: integer('cached_tokens'),
    costUsd: real('cost_usd').notNull(),
    cached: integer('cached', { mode: 'boolean' }).notNull(),
    /** null until F-5.12 versions the prompts. */
    promptVersion: text('prompt_version'),
    contextHash: text('context_hash').notNull(),
    /**
     * F-16.1 (migration 0028): the cost the provider reported (OpenRouter's `usage.cost`, or the
     * MythScribe Cloud charge); null when it did not report one, on a cache hit, and on rows
     * written before. When set, `cost_usd` equals it.
     */
    reportedCostUsd: real('reported_cost_usd'),
    /** F-16.1: the completion tokens the model spent thinking, when the provider said. */
    reasoningTokens: integer('reasoning_tokens')
  },
  (t) => [index('ai_usage_at_idx').on(t.at), index('ai_usage_feature_idx').on(t.feature)]
)
export type AiUsageRow = typeof aiUsage.$inferSelect
export type AiUsageInsert = typeof aiUsage.$inferInsert

/**
 * Local response cache (CLAUDE.md, token efficiency rule 4). Keyed by the request path's own
 * hash of feature, prompt version, model, and context, never by a caller's raw context hash
 * alone. Invalidated by content, never by time; bounded to 500 rows, oldest evicted on write.
 */
export const aiCache = sqliteTable('ai_cache', {
  contextHash: text('context_hash').primaryKey(),
  feature: text('feature').notNull(),
  promptVersion: text('prompt_version'),
  model: text('model').notNull(),
  /** The completion text. */
  response: text('response').notNull(),
  /** JSON: `{ inputTokens, outputTokens }`. */
  usage: text('usage').notNull(),
  createdAt: text('created_at').notNull()
})
export type AiCacheRow = typeof aiCache.$inferSelect
export type AiCacheInsert = typeof aiCache.$inferInsert

/**
 * An author-marked voice exemplar (F-14.1): a plain-text snapshot of a passage, the POV of the
 * document it came from, and its kind (`classifyKind`). The node reference is cleared, not
 * cascaded, when the node goes: the profile still needs the passage.
 */
export const voiceExemplar = sqliteTable(
  'voice_exemplar',
  {
    id: text('id').primaryKey(),
    /** The node the passage was marked in; null once that node is deleted. */
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    /** Plain text, not Tiptap JSON; the contract bounds its length. */
    text: text('text').notNull(),
    /** The source document's `scene_meta.pov` at mark time, trimmed; null when empty. */
    pov: text('pov'),
    kind: text('kind', { enum: EXEMPLAR_KINDS }).notNull(),
    created: text('created').notNull(),
    /** F-14.14: `author` (marked by hand) or `auto` (picked by the local voice job). */
    source: text('source', { enum: VOICE_EXEMPLAR_SOURCES }).notNull().default('author')
  },
  (t) => [index('voice_exemplar_created_idx').on(t.created)]
)
export type VoiceExemplarRow = typeof voiceExemplar.$inferSelect
export type VoiceExemplarInsert = typeof voiceExemplar.$inferInsert

/**
 * One AI output the author can act on (F-14.5): what produced it, what it cost, the text, and
 * how the author settled it. `content` is the proposal text (ghost text) or a historical
 * snapshot (tag recommendations store the names as JSON); `flagged`/`violation` are set only
 * by prose-generating features (the F-14.7 fidelity check); `target_from`/`target_to` are the
 * document range a rewrite would replace (F-14.10 fills them). The node reference is cleared,
 * not cascaded, when the node goes; `regenerated_from` links a regenerate to the proposal it
 * replaced and is cleared when that row is evicted.
 */
export const aiProposal = sqliteTable(
  'ai_proposal',
  {
    id: text('id').primaryKey(),
    /** ISO timestamp. */
    createdAt: text('created_at').notNull(),
    /** An `AiFeatureId`. */
    feature: text('feature').notNull(),
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    cached: integer('cached', { mode: 'boolean' }).notNull(),
    /** The proposal text; not `text`, which is the column builder's name. */
    content: text('content').notNull(),
    /** null when the feature runs no fidelity check. */
    flagged: integer('flagged', { mode: 'boolean' }),
    violation: text('violation'),
    targetFrom: integer('target_from'),
    targetTo: integer('target_to'),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('pending'),
    /** The author's note on a rejection or a regenerate; a negative example for later features. */
    note: text('note'),
    /** ISO timestamp; null while pending. */
    settledAt: text('settled_at'),
    regeneratedFrom: text('regenerated_from').references((): AnySQLiteColumn => aiProposal.id, {
      onDelete: 'set null'
    })
  },
  (t) => [
    index('ai_proposal_created_at_idx').on(t.createdAt),
    index('ai_proposal_node_idx').on(t.nodeId)
  ]
)
export type AiProposalRow = typeof aiProposal.$inferSelect
export type AiProposalInsert = typeof aiProposal.$inferInsert

/**
 * A scene's derived summary (F-5.6): the ~100-token summary, its key points, and the
 * characters present, written in the background after the author pauses typing. One row per
 * manuscript document, keyed by the node and cascaded with it: a deleted scene has no index
 * data. `content_hash` is the hash of everything that was sent (the scene text as sent, the
 * metadata, the character names), so staleness is a comparison, never a timestamp (CLAUDE.md,
 * token efficiency rule 4). `key_points` and `characters` are JSON arrays; the shapes and the
 * caps live in `src/shared/summary.ts`. A summary is not a proposal: nothing enters the
 * manuscript, so its only other trace is the `ai_usage` row that paid for it.
 */
export const sceneSummary = sqliteTable('scene_summary', {
  nodeId: text('node_id')
    .primaryKey()
    .references(() => node.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  summary: text('summary').notNull(),
  /** JSON array of strings. */
  keyPoints: text('key_points').notNull(),
  /** JSON array of strings. */
  characters: text('characters').notNull(),
  promptVersion: text('prompt_version').notNull(),
  model: text('model').notNull(),
  /** Whether the scene was head-truncated to `SUMMARY_SCENE_CHAR_BUDGET` before it was sent. */
  truncated: integer('truncated', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  /**
   * F-9.14 (migration `0024_scene_cards`): the AI part of the scene card as JSON (`AiSceneCard`),
   * written by `summary.v4` and later; null for a row an older prompt wrote. An older build reads
   * past it and, on its own rewrite of the row, leaves it as it was: a card is shown only with a
   * row of a version that writes one.
   */
  card: text('card')
})
export type SceneSummaryRow = typeof sceneSummary.$inferSelect
export type SceneSummaryInsert = typeof sceneSummary.$inferInsert

/**
 * A job waiting in the background index queue (F-5.13). Only what must survive a quit is here:
 * `queued` jobs and the ones that gave up (`failed`), one row per kind and node, keyed
 * `<kind>:<node_id>`. A running job is memory-only, so a crash leaves its row `queued` and
 * reopening the project resumes it; a finished job leaves no row at all (the `scene_summary` it
 * wrote and the `ai_usage` row that paid for it are its record). Cascaded with the node: a
 * deleted scene has nothing left to index. `last_error` is a JSON `JobFailure` on a failed row.
 */
export const indexJob = sqliteTable('index_job', {
  /** `<kind>:<node_id>`: one job per kind and node, so a burst of saves cannot pile up rows. */
  id: text('id').primaryKey(),
  /** A `JobKind`. */
  kind: text('kind').notNull(),
  nodeId: text('node_id')
    .notNull()
    .references(() => node.id, { onDelete: 'cascade' }),
  /** A `JobStatus`: 'queued' or 'failed'. */
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  /** JSON `JobFailure` for a failed row; null otherwise. */
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})
export type IndexJobRow = typeof indexJob.$inferSelect
export type IndexJobInsert = typeof indexJob.$inferInsert

/**
 * Where a tag's name occurs in a document (F-4.12): one row per tag and node, written by the
 * local mention scan after every save, never by the author. A document without a single
 * occurrence has no row at all, so "mentioned in N documents" is a count of rows. `positions`
 * is a JSON array of `[from, to]` ProseMirror ranges of the document as it was saved, which is
 * what a jump selects; the count is stored beside it so the lists need no parse to sort.
 * Cascaded from both ends: neither a deleted tag nor a deleted scene leaves mentions behind.
 */
export const tagMention = sqliteTable(
  'tag_mention',
  {
    /** `<tag_id>:<node_id>`: one row per pair, so a rescan replaces rather than piles up. */
    id: text('id').primaryKey(),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    count: integer('count').notNull(),
    /** JSON array of `[from, to]` pairs; a cell that no longer parses reads as no ranges. */
    positions: text('positions').notNull(),
    /**
     * F-9.12: JSON array of the paragraph index (`passageParagraphs`) each range of `positions`
     * sits in, one per range; `[]` on a row written before F-9.12, until the rescan fills it.
     */
    paragraphs: text('paragraphs').notNull().default('[]'),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [index('tag_mention_tag_idx').on(t.tagId), index('tag_mention_node_idx').on(t.nodeId)]
)
export type TagMentionRow = typeof tagMention.$inferSelect
export type TagMentionInsert = typeof tagMention.$inferInsert

/**
 * What the last mention scan of a document saw (F-4.12): the hash of its text and of the tags
 * that were candidates then. A save whose hash still matches is skipped without a single write,
 * and a renamed, retired, or new tag changes the hash for every document, which is how the
 * backfill after a tag change finds its work. Cascaded with the node.
 */
export const mentionScan = sqliteTable('mention_scan', {
  nodeId: text('node_id')
    .primaryKey()
    .references(() => node.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  scannedAt: text('scanned_at').notNull(),
  /**
   * F-9.12: the hash of the paragraphs last written to `passage_fts` for this document (the
   * full-text index, a virtual table drizzle does not model: migration 0022). Null until the
   * first scan after F-9.12; a match skips rewriting the document's passages.
   */
  passageHash: text('passage_hash')
})
export type MentionScanRow = typeof mentionScan.$inferSelect
export type MentionScanInsert = typeof mentionScan.$inferInsert

/**
 * One entity of the story bible (F-9.1): a character, a setting, or a world-building item. The
 * author writes it either through the kind's structured template (`fields`, a JSON object of the
 * template's values keyed by field id) or as a blank page (`body`); both columns exist whatever
 * `template` says, so switching it loses nothing. `name` is stored as the author typed it,
 * trimmed, and is unique per kind on `toEntityNameKey` — enforced in the store, not by an index,
 * since the key collapses whitespace and lower-cases beyond what SQLite compares. `image` is an
 * asset file name written by F-9.3, and `tag_id` is the entity's tag (F-9.4), cleared rather
 * than cascaded when that tag goes: the entity outlives its tag.
 */
export const entity = sqliteTable(
  'entity',
  {
    id: text('id').primaryKey(),
    /** F-9.11: a category id (library or `story_category`); the F-9.1 kinds are library ids. */
    kind: text('kind').notNull(),
    /** The author's spelling, trimmed; compared through `toEntityNameKey`. */
    name: text('name').notNull(),
    template: text('template', { enum: ENTITY_TEMPLATES }).notNull().default('structured'),
    /** JSON object of the template's values; `{}` when nothing is filled in. */
    fields: text('fields').notNull().default('{}'),
    /** The blank page's text; null until something is written. */
    body: text('body'),
    /** File name under the project's `assets/entities/`; null until F-9.3 uploads one. */
    image: text('image'),
    /** F-9.4 writes it; null everywhere until then. */
    tagId: text('tag_id').references(() => tag.id, { onDelete: 'set null' }),
    /** F-5.16: `ai` for an entity the story-bible job created, until the author's first edit. */
    origin: text('origin', { enum: ENTITY_ORIGINS }).notNull().default('author'),
    /**
     * F-4.14: JSON array of the sheet's other names, used only while `tag_id` is null; a linked
     * sheet's aliases live on its tag (one owner).
     */
    aliases: text('aliases').notNull().default('[]'),
    created: text('created').notNull(),
    modified: text('modified').notNull(),
    /** F-9.13 (D7): canon, plan, or idea; the author flips it on the sheet. */
    status: text('status', { enum: FACT_STATUSES }).notNull().default('canon'),
    /**
     * F-9.18: JSON array of the sheet's own fields `[{ id, label, multiline }]`, beside its
     * category's template: what the page said that no field of the category holds. `[]` for a
     * sheet with none (every sheet written before F-9.18).
     */
    extraFields: text('extra_fields').notNull().default('[]'),
    /**
     * F-9.18: JSON `StoredSheetSync` (src/main/entity/sheetSync.ts), main-only: the fields hash
     * and the page as of the last time the two views were made true to each other, which page
     * paragraphs the AI wrote, and a write-up held for the author at Ask. Null until the first.
     */
    sync: text('sync')
  },
  (t) => [index('entity_kind_name_idx').on(t.kind, t.name)]
)
export type EntityRow = typeof entity.$inferSelect
export type EntityInsert = typeof entity.$inferInsert
/**
 * F-9.13: what the entity store may insert or patch. `fields` is left out on purpose: its one
 * writer is `writeAuthorFields` (src/main/entity/factStore.ts), so the author's sheet text and
 * its baseline facts never disagree.
 */
export type EntityInsertWithoutFields = Omit<EntityInsert, 'fields'>

/**
 * The project's story-bible categories (F-9.11), beside the built-in library of
 * `shared/categories.ts`. A row with `fields` is one of the project's own categories (`c-…`, made
 * by the author or accepted from the AI): its template is the JSON array of `{ id, label,
 * multiline }`. A row with null `fields` carries a library id and only renames that category
 * (name, singular, icon); deleting it restores the library's. `entity.kind` points here or at a
 * library id, by value: there is no foreign key, so a sheet always outlives its category's row.
 */
export const storyCategory = sqliteTable('story_category', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  noun: text('noun').notNull(),
  icon: text('icon', { enum: CATEGORY_ICONS }).notNull(),
  /** JSON array of the template's fields; null for a rename of a library category. */
  fields: text('fields'),
  /** What goes in it, for the AI's sorting prompt; '' when nobody said. */
  hint: text('hint').notNull().default(''),
  origin: text('origin', { enum: CATEGORY_ORIGINS }).notNull(),
  created: text('created').notNull(),
  modified: text('modified').notNull()
})
export type StoryCategoryRow = typeof storyCategory.$inferSelect
export type StoryCategoryInsert = typeof storyCategory.$inferInsert

/**
 * One thing the manuscript states about an entity (F-5.16): the attribute (a field id of the
 * entity's kind, `OBSERVED_ATTRIBUTES`), the value, and the passage of the scene it was read
 * from. Written by the background story-bible job with the scene's summary, never by the author,
 * and kept apart from the entity's own `fields` and `body`. Cascaded from both ends: neither a
 * deleted entity nor a deleted scene leaves facts behind. `hidden` is the author's "this one is
 * wrong": the row stays as a tombstone so re-reading the scene does not bring the fact back.
 */
export const observedFact = sqliteTable(
  'observed_fact',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    attribute: text('attribute').notNull(),
    value: text('value').notNull(),
    /** The words of the scene the fact was read from; what a jump to the passage selects. */
    quote: text('quote').notNull(),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    index('observed_fact_entity_idx').on(t.entityId),
    index('observed_fact_node_idx').on(t.nodeId)
  ]
)
export type ObservedFactRow = typeof observedFact.$inferSelect
export type ObservedFactInsert = typeof observedFact.$inferInsert

/**
 * Dated facts (F-9.13), the knowledge model's statements about a record: the author's (the
 * undated baseline mirrors `entity.fields`, one row per filled field, written only by
 * `writeAuthorFact`; a row dated at a scene holds from there on) and the AI's (read from a scene,
 * always with its quote; `hidden` is the author's tombstone). `fact_key` is unique per record
 * (`aiFactKey` / `authorFactKey`). A deleted scene takes its AI facts with it in the same
 * transaction (`deleteAiFactsUnder`); the column is SET NULL so an author line survives.
 * `object_entity_id` is for relationships (phase P3). F-5.16's `observed_fact` stays, frozen, for
 * older builds (decision D9).
 */
export const fact = sqliteTable(
  'fact',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    attribute: text('attribute').notNull(),
    value: text('value').notNull(),
    objectEntityId: text('object_entity_id').references(() => entity.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    quote: text('quote'),
    origin: text('origin', { enum: FACT_ORIGINS }).notNull(),
    status: text('status', { enum: FACT_STATUSES }).notNull().default('canon'),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    factKey: text('fact_key').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [
    index('fact_entity_attribute_idx').on(t.entityId, t.attribute),
    index('fact_node_idx').on(t.nodeId),
    index('fact_object_idx').on(t.objectEntityId),
    uniqueIndex('fact_entity_key_uq').on(t.entityId, t.factKey)
  ]
)
export type FactRow = typeof fact.$inferSelect
export type FactInsert = typeof fact.$inferInsert

/**
 * The Changes log (F-9.13, D12): one row per change the background reading applied on its own,
 * grouped by `run_id` (one reading of one scene). `undo` is the JSON `ChangeUndo` main runs to
 * take it back through an existing tombstone; `target_id` is the fact, sheet, or tag it made.
 * Pruned to `CHANGES_MAX` rows.
 */
export const knowledgeChange = sqliteTable(
  'knowledge_change',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    createdAt: text('created_at').notNull(),
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    quote: text('quote'),
    kind: text('kind', { enum: CHANGE_KINDS }).notNull(),
    entityId: text('entity_id').references(() => entity.id, { onDelete: 'set null' }),
    targetId: text('target_id').notNull(),
    label: text('label').notNull(),
    undo: text('undo').notNull(),
    status: text('status', { enum: CHANGE_STATUSES }).notNull().default('applied')
  },
  (t) => [
    index('knowledge_change_created_idx').on(t.createdAt),
    index('knowledge_change_run_idx').on(t.runId)
  ]
)
export type KnowledgeChangeRow = typeof knowledgeChange.$inferSelect
export type KnowledgeChangeInsert = typeof knowledgeChange.$inferInsert

/**
 * One contradiction the consistency checker found (F-13.4): a passage of a scene (`quote`)
 * against one reference of the story bible as it was when the check ran (`ref_*`: a sheet field,
 * an observed fact of another scene with its passage, or the previous scene's timeline). Derived
 * data, never in the manuscript: the fix enters the text only through its proposal (F-14.5).
 * A run replaces the scene's `open` rows; a `dismissed` row stays as a tombstone, and
 * `dedupe_key` (`continuityDedupeKey`) is what a later run is checked against so the same
 * contradiction is not raised again for that scene. Cascaded with the scene and the entity; the
 * referenced scene and the proposal are cleared, not cascaded.
 */
export const continuityFinding = sqliteTable(
  'continuity_finding',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    refKind: text('ref_kind', { enum: CONTINUITY_REF_KINDS }).notNull(),
    entityId: text('entity_id').references(() => entity.id, { onDelete: 'cascade' }),
    /** The entity's name and kind when the check ran; null for a timeline reference. */
    entityName: text('entity_name'),
    entityKind: text('entity_kind'),
    attribute: text('attribute'),
    refLabel: text('ref_label').notNull(),
    refValue: text('ref_value').notNull(),
    refNodeId: text('ref_node_id').references(() => node.id, { onDelete: 'set null' }),
    refQuote: text('ref_quote'),
    /** The words of the scene that contradict the reference; what a jump selects and the fix replaces. */
    quote: text('quote').notNull(),
    why: text('why').notNull(),
    fix: text('fix'),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
    violation: text('violation'),
    status: text('status', { enum: CONTINUITY_STATUSES }).notNull().default('open'),
    origin: text('origin', { enum: CONTINUITY_ORIGINS }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    proposalId: text('proposal_id').references(() => aiProposal.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull()
  },
  (t) => [
    index('continuity_finding_node_idx').on(t.nodeId),
    index('continuity_finding_status_idx').on(t.status)
  ]
)
export type ContinuityFindingRow = typeof continuityFinding.$inferSelect
export type ContinuityFindingInsert = typeof continuityFinding.$inferInsert

/**
 * Words written, by local day and hour (F-10.3): the net word-count change of manuscript
 * documents saved from the editor, plus the active writing time those saves covered. One row per
 * `(day, hour)` bucket, upserted on every counted save; import, replace, delete, move, and
 * duplicate never write here. `day` is `YYYY-MM-DD` and `hour` 0–23 on the machine's local
 * clock; `words` may be negative for an hour spent cutting. Hourly so the statistics dashboard
 * (F-10.5: heatmap, words per day, productive hours) reads the same table.
 */
export const writingLog = sqliteTable(
  'writing_log',
  {
    day: text('day').notNull(),
    hour: integer('hour').notNull(),
    words: integer('words').notNull().default(0),
    activeMs: integer('active_ms').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.day, t.hour] })]
)
export type WritingLogRow = typeof writingLog.$inferSelect

/**
 * Named drafts of the manuscript's text (F-8.5). The tree is shared; only the text of manuscript
 * documents differs between drafts. The active draft (settings key `activeDraft`) has no rows of
 * its own: its text is the live `node.content`. Names are unique case-insensitively, checked in
 * `draftStore.ts`. `position` is the list order (oldest first).
 */
export const draft = sqliteTable('draft', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  created: text('created').notNull(),
  modified: text('modified').notNull()
})
export type DraftRow = typeof draft.$inferSelect

/**
 * An inactive draft's text of one document (F-8.5): the stored Tiptap JSON (null = empty, as on
 * `node.content`) and its cached word count. A document with no row reads its live text in that
 * draft. Both ends cascade on delete.
 */
export const draftText = sqliteTable(
  'draft_text',
  {
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    content: text('content'),
    wordCount: integer('word_count').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.draftId, t.nodeId] })]
)
export type DraftTextRow = typeof draftText.$inferSelect

/**
 * A snapshot (F-8.6): a frozen copy of document text, of one document (`scope` `document`,
 * `node_id` set, deleted with it) or several (`project`, `node_id` null). `draft_name` is the
 * draft that was active when it was taken. Kinds and pruning are in `snapshotStore.ts`.
 */
export const snapshot = sqliteTable('snapshot', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  note: text('note').notNull().default(''),
  kind: text('kind', { enum: SNAPSHOT_KINDS }).notNull(),
  scope: text('scope', { enum: SNAPSHOT_SCOPES }).notNull(),
  nodeId: text('node_id').references(() => node.id, { onDelete: 'cascade' }),
  draftName: text('draft_name'),
  created: text('created').notNull()
})
export type SnapshotRow = typeof snapshot.$inferSelect

/**
 * One document's text in a snapshot (F-8.6): the stored Tiptap JSON (null = empty) and its word
 * count. Both ends cascade on delete.
 */
export const snapshotText = sqliteTable(
  'snapshot_text',
  {
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => snapshot.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    content: text('content'),
    wordCount: integer('word_count').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.nodeId] })]
)
export type SnapshotTextRow = typeof snapshotText.$inferSelect

/**
 * One edit pass (F-14.15): its type, the custom instruction, the scenes it covers in reading
 * order (`node_ids`, JSON) and the ones it has finished (`done_node_ids`, JSON, so a pass stopped
 * by a crash or a cancel can resume where it was), what it cost, and how it ended. `excerpt` is
 * the selected passage a one-scene pass reads instead of the whole scene (F-5.26, 2026-10-11; null
 * for a pass over whole scenes). Derived data: nothing here is the author's text until a change
 * is accepted in the editor. Notes redesign phase 2 (migration 0042): a run of the edit flow is a
 * row with `flow` set (JSON: the spec, the scope's title, the requests answered of all), its
 * developmental `overview`, and the note pages Update notes changed (`note_edits`, JSON); `type`
 * is `custom` and unused there, and `node_ids` holds the scope's scenes.
 */
export const editPass = sqliteTable(
  'edit_pass',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: EDIT_PASS_TYPES }).notNull(),
    instruction: text('instruction'),
    excerpt: text('excerpt'),
    status: text('status', { enum: EDIT_PASS_STATUSES }).notNull(),
    nodeIds: text('node_ids').notNull(),
    doneNodeIds: text('done_node_ids').notNull().default('[]'),
    model: text('model').notNull().default(''),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    dropped: integer('dropped').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
    flow: text('flow'),
    overview: text('overview'),
    noteEdits: text('note_edits').notNull().default('[]')
  },
  (t) => [index('edit_pass_created_idx').on(t.createdAt)]
)
export type EditPassRow = typeof editPass.$inferSelect

/**
 * One tracked change or developmental note of a pass (F-14.15). `original` is the passage as it
 * read when the pass ran (it occurred exactly once in the scene), `replacement` what the editor
 * proposes ('' cuts it; null for a note). The renderer finds `original` again before it shows or
 * applies anything, so a change the author's later edits orphaned is marked `stale`, never
 * misapplied. Cascaded from the pass and from the scene; the proposal is set null when evicted.
 * `flow_category` (notes redesign phase 2, migration 0042) is the edit-flow category an issue was
 * found under; null for an edit-pass change. In the flow a `note` row is an issue with no fix.
 */
export const editChange = sqliteTable(
  'edit_change',
  {
    id: text('id').primaryKey(),
    passId: text('pass_id')
      .notNull()
      .references(() => editPass.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: EDIT_CHANGE_KINDS }).notNull(),
    position: integer('position').notNull(),
    original: text('original').notNull(),
    replacement: text('replacement'),
    rationale: text('rationale').notNull(),
    category: text('category', { enum: DEVELOPMENTAL_CATEGORIES }),
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
    violation: text('violation'),
    status: text('status', { enum: EDIT_CHANGE_STATUSES }).notNull().default('pending'),
    proposalId: text('proposal_id').references(() => aiProposal.id, { onDelete: 'set null' }),
    flowCategory: text('flow_category', { enum: EDIT_FLOW_CATEGORIES })
  },
  (t) => [index('edit_change_pass_idx').on(t.passId), index('edit_change_node_idx').on(t.nodeId)]
)
export type EditChangeRow = typeof editChange.$inferSelect

/**
 * One uploaded file of the context library (F-9.8). `stored` is the original's file name under
 * the project's `assets/library/` (`<stem>.<8 hex>.<ext>`); `hash` is the file's SHA-256, so an
 * identical re-upload changes nothing. `text_hash` is the SHA-256 of the extracted text (null for
 * an image, or a document with no text: a scanned PDF). `processed_text` and `processed_hash` are
 * the text as it was last sorted into the story bible, so an updated upload sends only the
 * paragraphs that changed; `processed_at` is when Apply ran. The state is derived from the hashes.
 */
export const contextFile = sqliteTable(
  'context_file',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type', { enum: CONTEXT_FILE_TYPES }).notNull(),
    size: integer('size').notNull(),
    hash: text('hash').notNull(),
    stored: text('stored').notNull(),
    words: integer('words').notNull().default(0),
    textHash: text('text_hash'),
    processedHash: text('processed_hash'),
    processedText: text('processed_text'),
    processedAt: text('processed_at'),
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [index('context_file_name_idx').on(t.name)]
)
export type ContextFileRow = typeof contextFile.$inferSelect
export type ContextFileInsert = typeof contextFile.$inferInsert

/**
 * One item of the To do list (F-9.16, migration `0025_todo`): something the book leaves
 * unexplained, contradicted, unfinished, or unstated, found by a local rule or the author's
 * whole-book AI check. Derived data, never in the manuscript (CLAUDE.md, AI rule 1): the
 * author's Add writes a line to a sheet, notes, or a brief through the renderer's own owners,
 * and the row only records that it was handled. `key` (`todoKey`) is unique: a `done` or
 * `dismissed` row is the tombstone that keeps the same item from coming back, and a sync only
 * ever upserts or deletes `open` rows. The contradictions of the consistency checker are not
 * copied here; they are read live from `continuity_finding`. `target` is a JSON `TodoTarget`,
 * `suggestions` a JSON array of strings (options for the author, never facts). The scene and the
 * record are cleared, not cascaded; the sync drops an open row whose scene or record went.
 */
export const todoItem = sqliteTable(
  'todo_item',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    kind: text('kind', { enum: TODO_KINDS }).notNull(),
    rule: text('rule', { enum: TODO_RULES }).notNull(),
    source: text('source', { enum: TODO_SOURCES }).notNull(),
    subject: text('subject').notNull(),
    entityId: text('entity_id').references(() => entity.id, { onDelete: 'set null' }),
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    quote: text('quote'),
    why: text('why').notNull(),
    target: text('target').notNull(),
    suggestions: text('suggestions').notNull().default('[]'),
    suggestedAt: text('suggested_at'),
    status: text('status', { enum: TODO_STATUSES }).notNull().default('open'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [
    index('todo_item_status_idx').on(t.status),
    index('todo_item_entity_idx').on(t.entityId),
    index('todo_item_node_idx').on(t.nodeId)
  ]
)
export type TodoItemRow = typeof todoItem.$inferSelect
export type TodoItemInsert = typeof todoItem.$inferInsert

/**
 * Story memory v2 (F-16.4, phase P1, migration 0029): a record, what names and nicknames point
 * at. It replaces the v1 tag and sheet in a v2 project; a v1 project never writes here. The
 * category is by value with no foreign key (`entity.kind` does the same), the kind follows it
 * (`recordKindOf`), `image` is an asset file name under `assets/entities/` (the folder sheets
 * use), `pinned` and `ideas` are Tiptap JSON (null while empty). `legacy_entity_id` and
 * `legacy_tag_id` let the switch-over (P1 slice 6) run once per source row and show its mapping;
 * they have no foreign key, since the v1 rows may go at P9. The table starts empty: nothing is
 * copied in a migration (decision P1-D1).
 */
export const record = sqliteTable(
  'record',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id').notNull(),
    image: text('image'),
    origin: text('origin', { enum: RECORD_ORIGINS }).notNull().default('author'),
    pinned: text('pinned'),
    ideas: text('ideas'),
    legacyEntityId: text('legacy_entity_id'),
    legacyTagId: text('legacy_tag_id'),
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [
    index('record_category_idx').on(t.categoryId),
    uniqueIndex('record_legacy_entity_uq').on(t.legacyEntityId),
    uniqueIndex('record_legacy_tag_uq').on(t.legacyTagId)
  ]
)
export type RecordRow = typeof record.$inferSelect
export type RecordInsert = typeof record.$inferInsert

/**
 * A record's names (F-16.4): exactly one `is_main` per record (its name, one owner), the rest
 * nicknames, titles and other spellings. `norm` is `normName(text)`, unique per record; a norm
 * may belong to several records only when every one of them marks it `shared` (identity rule 4),
 * which the store checks and the partial unique index backs for unshared rows.
 */
export const alias = sqliteTable(
  'alias',
  {
    id: text('id').primaryKey(),
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    norm: text('norm').notNull(),
    isMain: integer('is_main', { mode: 'boolean' }).notNull().default(false),
    caseRule: text('case_rule', { enum: CASE_RULES }).notNull().default('auto'),
    origin: text('origin', { enum: ALIAS_ORIGINS }).notNull().default('author'),
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    created: text('created').notNull()
  },
  (t) => [
    uniqueIndex('alias_record_norm_uq').on(t.recordId, t.norm),
    uniqueIndex('alias_norm_unshared_uq')
      .on(t.norm)
      .where(sql`${t.shared} = 0`),
    uniqueIndex('alias_main_uq')
      .on(t.recordId)
      .where(sql`${t.isMain} = 1`),
    index('alias_norm_idx').on(t.norm)
  ]
)
export type AliasRow = typeof alias.$inferSelect
export type AliasInsert = typeof alias.$inferInsert

/**
 * The author's labels (F-16.7): name, colour, kind, order. Names are unique case-insensitively,
 * enforced in the store (`labelNameKey`). `legacy_tag_id` is the switch-over's mapping.
 */
export const label = sqliteTable('label', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  colour: text('colour').notNull(),
  kind: text('kind', { enum: LABEL_KINDS }).notNull(),
  position: integer('position').notNull(),
  legacyTagId: text('legacy_tag_id'),
  created: text('created').notNull(),
  modified: text('modified').notNull()
})
export type LabelRow = typeof label.$inferSelect
export type LabelInsert = typeof label.$inferInsert

/** Which scenes and Research documents carry a label (F-16.7). Both ends cascade. */
export const labelLink = sqliteTable(
  'label_link',
  {
    labelId: text('label_id')
      .notNull()
      .references(() => label.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.labelId, t.nodeId] }), index('label_link_node_idx').on(t.nodeId)]
)
export type LabelLinkRow = typeof labelLink.$inferSelect

/**
 * One Dismissed list (F-16.10): every "never bring this back" of v2, one row per tombstone,
 * unique per kind and key (`dismissedKey`). The record's rows go with it; a node that goes leaves
 * the row with the link cleared.
 */
export const dismissed = sqliteTable(
  'dismissed',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: DISMISSED_KINDS }).notNull(),
    key: text('key').notNull(),
    recordId: text('record_id').references(() => record.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    quote: text('quote'),
    created: text('created').notNull()
  },
  (t) => [uniqueIndex('dismissed_kind_key_uq').on(t.kind, t.key)]
)
export type DismissedRow = typeof dismissed.$inferSelect
export type DismissedInsert = typeof dismissed.$inferInsert

/** The author's own to-dos (F-16.10). A scene or record it points at may go; the to-do stays. */
export const authorTodo = sqliteTable('author_todo', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  nodeId: text('node_id').references(() => node.id, { onDelete: 'set null' }),
  recordId: text('record_id').references(() => record.id, { onDelete: 'set null' }),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull(),
  created: text('created').notNull(),
  doneAt: text('done_at')
})
export type AuthorTodoRow = typeof authorTodo.$inferSelect
export type AuthorTodoInsert = typeof authorTodo.$inferInsert

/**
 * A scene's typed details (F-16.11): POV and place point at records (cleared when the record
 * goes), place and time keep free text, `story_year` is an integer, `also_here` a JSON array of
 * record ids (an id with no record reads as gone). Its own table rather than `scene_meta` keys,
 * so an older build that saves scene meta cannot drop them.
 */
export const sceneDetail = sqliteTable('scene_detail', {
  nodeId: text('node_id')
    .primaryKey()
    .references(() => node.id, { onDelete: 'cascade' }),
  povRecordId: text('pov_record_id').references(() => record.id, { onDelete: 'set null' }),
  placeRecordId: text('place_record_id').references(() => record.id, { onDelete: 'set null' }),
  placeText: text('place_text').notNull().default(''),
  timeText: text('time_text').notNull().default(''),
  storyYear: integer('story_year'),
  alsoHere: text('also_here').notNull().default('[]'),
  modified: text('modified').notNull(),
  /**
   * The author's Flashback switch (F-16.11, F-16.23; migration 0040, the author's decision
   * 2026-10-14): null follows the book's reading (the card's verified flashback), true is a
   * flashback, false is not one. The author's setting wins (`sceneFlashback`).
   */
  flashback: integer('flashback', { mode: 'boolean' })
})
export type SceneDetailRow = typeof sceneDetail.$inferSelect
export type SceneDetailInsert = typeof sceneDetail.$inferInsert

/**
 * Where a scene names a record (F-16.5, migration 0030): one row per mention, written by the
 * local name scan (`nameIndexer.ts`) after every save, never by the author. `from`/`to` are
 * ProseMirror positions of the saved document (as `tag_mention` stores them), `para` the
 * paragraph index. An ambiguous span (a shared alias nothing settled) has one row per possible
 * owner, grouped by `span_key` (`para:from`). Cascaded from both ends.
 */
export const nameMention = sqliteTable(
  'name_mention',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    para: integer('para').notNull(),
    from: integer('from').notNull(),
    to: integer('to').notNull(),
    text: text('text').notNull(),
    ambiguous: integer('ambiguous', { mode: 'boolean' }).notNull().default(false),
    spanKey: text('span_key').notNull()
  },
  (t) => [
    index('name_mention_node_idx').on(t.nodeId),
    index('name_mention_record_idx').on(t.recordId)
  ]
)
export type NameMentionRow = typeof nameMention.$inferSelect
export type NameMentionInsert = typeof nameMention.$inferInsert

/**
 * What the last name scan and the last passage index of an owner saw (F-16.5): a scene, a scene's
 * notes, a record's pages or (from slice 2) a Research page. A hash that still matches skips the
 * work. No foreign key, since owners are nodes or records: rows whose owner went are pruned on
 * open (`pruneMemoryIndex`).
 */
export const memoryScan = sqliteTable(
  'memory_scan',
  {
    ownerKind: text('owner_kind', { enum: MEMORY_OWNER_KINDS }).notNull(),
    ownerId: text('owner_id').notNull(),
    namesHash: text('names_hash'),
    passagesHash: text('passages_hash'),
    scannedAt: text('scanned_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.ownerKind, t.ownerId] })]
)
export type MemoryScanRow = typeof memoryScan.$inferSelect
export type MemoryScanInsert = typeof memoryScan.$inferInsert

/**
 * A Research document's meta (F-16.8, migration `0032_research_doc`): where it came from
 * (`written` in MythScribe or made from an `upload`), the original it was made from (kept in the
 * library folder; cleared, not cascaded, if that row ever goes), the original's type, whether its
 * text was read out of a PDF (`converted`), and whether the whole page is Not canon. The text
 * itself is the node's `content`, edited like any document. A Research node with no row reads as
 * written and canon (`writtenResearchDoc`). Story memory v2 only; v1 never writes it.
 */
export const researchDoc = sqliteTable('research_doc', {
  nodeId: text('node_id')
    .primaryKey()
    .references(() => node.id, { onDelete: 'cascade' }),
  origin: text('origin', { enum: RESEARCH_ORIGINS }).notNull(),
  contextFileId: text('context_file_id').references(() => contextFile.id, {
    onDelete: 'set null'
  }),
  fileType: text('file_type', { enum: CONTEXT_FILE_TYPES }),
  converted: integer('converted', { mode: 'boolean' }).notNull().default(false),
  notCanon: integer('not_canon', { mode: 'boolean' }).notNull().default(false),
  created: text('created').notNull(),
  /**
   * F-16.9 (migration `0033_research_filed`): when the page was filed into Pinned, and the hash of
   * its text then. Filing runs once per page; both stay null until it has.
   */
  filedAt: text('filed_at'),
  filedHash: text('filed_hash')
})
export type ResearchDocRow = typeof researchDoc.$inferSelect
export type ResearchDocInsert = typeof researchDoc.$inferInsert

/**
 * Story memory v2's evidence (F-16.17, F-16.18; migration `0034_story_reading`, additive): derived
 * rows only, each pointing at the reading that made it and the draft it was read in. Only the
 * active draft's rows are live (design §2.2); switching back to a draft whose anchors hold costs
 * nothing. Every table starts empty; v1 never writes them.
 *
 * `reading`: one row per reading of one scene (all its pages, P2a-D1): why, what was sent, which
 * prompt versions and model, tokens, the cost of reader and verify together, and the yields the
 * health gate reads.
 */
export const reading = sqliteTable(
  'reading',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: READING_PURPOSES }).notNull(),
    pages: integer('pages').notNull().default(1),
    /** JSON `[from, to][]`: the paragraph ranges sent. */
    paras: text('paras').notNull().default('[]'),
    promptVersion: text('prompt_version').notNull(),
    verifyVersion: text('verify_version'),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    cloud: integer('cloud', { mode: 'boolean' }).notNull().default(false),
    finishReason: text('finish_reason'),
    items: integer('items').notNull().default(0),
    quotesFound: integer('quotes_found').notNull().default(0),
    literal: integer('literal').notNull().default(0),
    verifySent: integer('verify_sent').notNull().default(0),
    verified: integer('verified').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    /** JSON `{ reason: count }`. */
    rejections: text('rejections').notNull().default('{}'),
    cut: integer('cut').notNull().default(0),
    created: text('created').notNull()
  },
  (t) => [
    index('reading_model_idx').on(t.model, t.created),
    index('reading_node_idx').on(t.nodeId, t.draftId)
  ]
)
export type ReadingRow = typeof reading.$inferSelect
export type ReadingInsert = typeof reading.$inferInsert

/**
 * What of a scene has been read, per draft (F-16.16; P2a-D2): every finished sentence counted as
 * read (JSON `[gateHash, normalised text][]`, the text kept so the cosmetic skip can compare and a
 * later roster can hash it again), window reads since the last full one, and when that was.
 */
export const sceneRead = sqliteTable(
  'scene_read',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    sentences: text('sentences').notNull().default('[]'),
    partials: integer('partials').notNull().default(0),
    fullAt: text('full_at'),
    readingId: text('reading_id').references(() => reading.id, { onDelete: 'set null' }),
    updated: text('updated').notNull(),
    /**
     * P2b (migration `0036_story_knows`, additive): a reader that reads knows and threads
     * (`reader.v2`+) has read the whole scene (a v2 first, full or rebuild read sets it; a v2
     * window read keeps it). With `settled` it gives "checked up to" without walking the book's
     * text (P2b-D9).
     */
    topicsRead: integer('topics_read', { mode: 'boolean' }).notNull().default(false),
    /**
     * Nothing finished is unread: set when the gate decides `nothing` or `cosmetic` and after a v2
     * reading that leaves nothing unread; cleared by the anchors job when a save leaves an unread
     * finished sentence.
     */
    settled: integer('settled', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.draftId] })]
)
export type SceneReadRow = typeof sceneRead.$inferSelect
export type SceneReadInsert = typeof sceneRead.$inferInsert

/**
 * A scene's card per draft (F-16.18): the AI's map of it, findable and never citable. Line and
 * gist, the quoted fields (JSON), who is on the page (JSON), mood and theme, the anchor of every
 * card quote (JSON hashes), the gate hashes of the finished sentences the card was made from (JSON:
 * a quarter changed since makes it due, P2a-D17) and a hash of the line (plan links run only when
 * it moves).
 */
export const card = sqliteTable(
  'card',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    readingId: text('reading_id').references(() => reading.id, { onDelete: 'set null' }),
    line: text('line').notNull(),
    gist: text('gist').notNull(),
    fields: text('fields').notNull().default('{}'),
    present: text('present').notNull().default('[]'),
    mood: text('mood'),
    theme: text('theme'),
    anchor: text('anchor').notNull().default('[]'),
    seen: text('seen').notNull().default('[]'),
    lineHash: text('line_hash'),
    created: text('created').notNull()
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.draftId] })]
)
export type CardRow = typeof card.$inferSelect
export type CardInsert = typeof card.$inferInsert

/**
 * One claim (F-16.17): what a scene's prose states about a record, with its quote, paragraph and
 * anchor (JSON hashes of the sentences its proof rests on), its proof (`literal` in code or
 * `verified`), its voice and mode, and its state. `record_id` is null while the claim waits on a
 * new name (`pending`, JSON); `how` and `from_id` are P2b's (knows claims: the learner is the
 * record, the secret the object, P2b-D6), added in 0034; `topic_quote_id` came with 0036.
 */
export const claim = sqliteTable(
  'claim',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    readingId: text('reading_id').references(() => reading.id, { onDelete: 'set null' }),
    recordId: text('record_id').references(() => record.id, { onDelete: 'cascade' }),
    pending: text('pending'),
    subjectText: text('subject_text'),
    slot: text('slot').notNull(),
    value: text('value').notNull(),
    valueKey: text('value_key').notNull(),
    objectId: text('object_id').references(() => record.id, { onDelete: 'set null' }),
    how: text('how'),
    fromId: text('from_id').references(() => record.id, { onDelete: 'set null' }),
    voice: text('voice', { enum: CLAIM_VOICES }).notNull(),
    speakerId: text('speaker_id').references(() => record.id, { onDelete: 'set null' }),
    mode: text('mode', { enum: CLAIM_MODES }).notNull(),
    quote: text('quote').notNull(),
    para: integer('para').notNull(),
    anchor: text('anchor').notNull().default('[]'),
    proof: text('proof', { enum: CLAIM_PROOFS }).notNull(),
    change: integer('change', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { enum: CLAIM_STATES }).notNull(),
    spot: text('spot', { enum: SPOT_VERDICTS }),
    spotTier: text('spot_tier', { enum: SPOT_TIERS }),
    spotAt: text('spot_at'),
    created: text('created').notNull(),
    proved: text('proved').notNull(),
    /**
     * P2b (migration `0036_story_knows`): the merged reveal a knows or thread claim came in with,
     * so *Split* moves exactly those (P2b-D5). Null for every other claim.
     */
    topicQuoteId: text('topic_quote_id').references((): AnySQLiteColumn => topicQuote.id, {
      onDelete: 'set null'
    })
  },
  (t) => [
    index('claim_node_idx').on(t.nodeId, t.draftId),
    index('claim_record_idx').on(t.recordId, t.slot),
    index('claim_state_idx').on(t.state)
  ]
)
export type ClaimRow = typeof claim.$inferSelect
export type ClaimInsert = typeof claim.$inferInsert

/**
 * A secret's or thread's reveal (F-16.22, F-16.23; migration `0036_story_knows`, derived): the
 * sentence that revealed the secret or opened the thread (`defining`), and every reveal another
 * reading proposed as a new topic that the checker judged the same (`merged`, P2b-D3, D4). Per
 * draft and anchored like a claim (`anchor`, the sentence hashes; `stating`, the gate texts of the
 * quote's sentences, a Dismissed key's input); `label` is the reader's label for it (at most 8
 * words). Live while its sentences stand; a topic with none left and no claim is pruned (P2b-D12).
 */
export const topicQuote = sqliteTable(
  'topic_quote',
  {
    id: text('id').primaryKey(),
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    role: text('role', { enum: TOPIC_QUOTE_ROLES }).notNull(),
    label: text('label').notNull(),
    para: integer('para').notNull(),
    quote: text('quote').notNull(),
    anchor: text('anchor').notNull().default('[]'),
    stating: text('stating').notNull().default('[]'),
    readingId: text('reading_id').references(() => reading.id, { onDelete: 'set null' }),
    state: text('state', { enum: TOPIC_QUOTE_STATES }).notNull(),
    created: text('created').notNull(),
    proved: text('proved').notNull()
  },
  (t) => [
    index('topic_quote_record_idx').on(t.recordId),
    index('topic_quote_node_idx').on(t.nodeId, t.draftId)
  ]
)
export type TopicQuoteRow = typeof topicQuote.$inferSelect
export type TopicQuoteInsert = typeof topicQuote.$inferInsert

/**
 * *Knew before the book* (F-16.22, design §2.5; migration `0036_story_knows`): the author says a
 * character or group knew a secret before the story starts. Author-owned; both ends cascade.
 */
export const knewBefore = sqliteTable(
  'knew_before',
  {
    secretId: text('secret_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    created: text('created').notNull()
  },
  (t) => [primaryKey({ columns: [t.secretId, t.recordId] })]
)
export type KnewBeforeRow = typeof knewBefore.$inferSelect

/**
 * AI-made plan links (F-16.21; P2a-D12): which drafted scene fulfils a planned one, matched in
 * code or picked by `planLinks.v2`. Derived, never in scene meta: the author's own links stay in
 * `fulfilledBy`, and *Keep* makes one hers. `draft_id` (migration `0035_plan_link_draft`,
 * additive) is the draft whose cards made the link: only the active draft's rows are live (design
 * §2.2); a row with none (made before 0035) is dropped on the next pass and matched again.
 */
export const planLink = sqliteTable('plan_link', {
  planId: text('plan_id')
    .primaryKey()
    .references(() => node.id, { onDelete: 'cascade' }),
  sceneId: text('scene_id')
    .notNull()
    .references(() => node.id, { onDelete: 'cascade' }),
  origin: text('origin', { enum: PLAN_LINK_ORIGINS }).notNull(),
  score: real('score').notNull().default(0),
  reason: text('reason').notNull().default(''),
  readingId: text('reading_id').references(() => reading.id, { onDelete: 'set null' }),
  created: text('created').notNull(),
  draftId: text('draft_id').references(() => draft.id, { onDelete: 'cascade' })
})
export type PlanLinkRow = typeof planLink.$inferSelect
export type PlanLinkInsert = typeof planLink.$inferInsert

/**
 * The lazy back-fill (F-16.17): one row per name a late record or nickname brought, so the
 * scenes read before it existed are read for it once (`due`, `asked` with a price, `done`,
 * `declined`).
 */
export const memoryBackfill = sqliteTable(
  'memory_backfill',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    norm: text('norm').notNull(),
    state: text('state', { enum: BACKFILL_STATES }).notNull(),
    pages: integer('pages').notNull().default(0),
    created: text('created').notNull(),
    doneAt: text('done_at')
  },
  (t) => [primaryKey({ columns: [t.recordId, t.norm] })]
)
export type MemoryBackfillRow = typeof memoryBackfill.$inferSelect
export type MemoryBackfillInsert = typeof memoryBackfill.$inferInsert

/**
 * Ms Scribe's search misses (F-16.25; plan P3 §1.1, migration `0037_search_miss`, additive):
 * a passage a widened answer (Self-Route) cited that the turn's searches had not returned. Local
 * and derived, never sent anywhere: the trigger for meaning search with embeddings (F-16.35) and
 * the count Settings shows. `question` is the author's message cut to 300 characters; `terms` the
 * navigator's search terms as JSON (at most 8); `prompt_version` the answer's. At most
 * `SEARCH_MISS_MAX` rows: an insert prunes the oldest (`searchMissStore.ts`).
 */
export const searchMiss = sqliteTable(
  'search_miss',
  {
    id: text('id').primaryKey(),
    created: text('created').notNull(),
    question: text('question').notNull(),
    terms: text('terms').notNull().default('[]'),
    nodeId: text('node_id')
      .notNull()
      .references(() => node.id, { onDelete: 'cascade' }),
    para: integer('para').notNull(),
    quote: text('quote').notNull(),
    promptVersion: text('prompt_version').notNull()
  },
  (t) => [index('search_miss_created_idx').on(t.created)]
)
export type SearchMissRow = typeof searchMiss.$inferSelect
export type SearchMissInsert = typeof searchMiss.$inferInsert

/**
 * A contradiction candidate and its verdicts (F-16.27; plan P4 §1.1, migration `0038_story_findings`,
 * additive; derived): a pair code found under one of rules C1–C7 (`candidates.ts`), its two sides as
 * JSON references (`FindingSide`: a claim, a presence or a note sentence, never a copy of the
 * quote), C4's year in `extra`, the judge's verdict in each order, the stronger check's, its state
 * and what judging it cost. `key` is its lifecycle identity (rule, variant and the *Not a problem*
 * key `np_key`), unique per draft; only the active draft's rows are live (design §2.2). The record
 * is the subject (the knower for C3, the thread for C5): its rows go with it, and with the draft.
 * `rendered` (0039) is what the verdicts were given for.
 */
export const finding = sqliteTable(
  'finding',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => draft.id, { onDelete: 'cascade' }),
    rule: text('rule', { enum: FINDING_RULES }).notNull(),
    variant: text('variant', { enum: FINDING_VARIANTS }),
    recordId: text('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    slot: text('slot').notNull(),
    key: text('key').notNull(),
    npKey: text('np_key').notNull(),
    /** JSON `FindingSide`. */
    a: text('a').notNull(),
    b: text('b').notNull(),
    /** JSON `FindingExtra`, or null. */
    extra: text('extra'),
    verdictAb: text('verdict_ab', { enum: JUDGE_VERDICTS }),
    verdictBa: text('verdict_ba', { enum: JUDGE_VERDICTS }),
    why: text('why'),
    confirm: text('confirm', { enum: JUDGE_VERDICTS }),
    confirmWhy: text('confirm_why'),
    state: text('state', { enum: FINDING_STATES }).notNull(),
    costUsd: real('cost_usd').notNull().default(0),
    shownAt: text('shown_at'),
    created: text('created').notNull(),
    judgedAt: text('judged_at'),
    confirmedAt: text('confirmed_at'),
    /**
     * JSON `FindingRendered` (migration `0039_finding_rendered`, additive; P4 slice 2 review): the
     * pair as the judge reads it when last rendered, a stamp of what its rendering reads and its
     * verdict-cache keys in both orders, so a change of words around unchanged sides (a time-skip
     * hint, a story year, a context sentence) is judged afresh and an unchanged pair is never
     * rendered again. Null until first rendered.
     */
    rendered: text('rendered')
  },
  (t) => [
    uniqueIndex('finding_draft_key_uq').on(t.draftId, t.key),
    index('finding_draft_state_idx').on(t.draftId, t.state),
    index('finding_record_idx').on(t.recordId)
  ]
)
export type FindingRow = typeof finding.$inferSelect
export type FindingInsert = typeof finding.$inferInsert

/**
 * The judge's verdicts remembered (F-16.27; plan P4 §1.1, derived, local, not per draft): one row
 * per pair-order judged, keyed by a hash of the prompt version, the tier, the order and the pair as
 * sent with scene numbers masked and names folded (slice 2), so the same words are never judged
 * twice, whatever the draft, a scene move or a Rename in book. At most `VERDICT_CACHE_MAX` rows: an
 * insert prunes the least recently used (`used`).
 */
export const verdictCache = sqliteTable(
  'verdict_cache',
  {
    key: text('key').primaryKey(),
    verdict: text('verdict', { enum: JUDGE_VERDICTS }).notNull(),
    why: text('why'),
    tier: text('tier').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    costUsd: real('cost_usd').notNull().default(0),
    created: text('created').notNull(),
    used: text('used').notNull()
  },
  (t) => [index('verdict_cache_used_idx').on(t.used)]
)
export type VerdictCacheRow = typeof verdictCache.$inferSelect
export type VerdictCacheInsert = typeof verdictCache.$inferInsert

/**
 * The notebook (notes redesign phase 1, migration `0041_notebook`): the author's note pages and
 * folders. `content` is Tiptap JSON (null for a folder or an empty page), `plain` its derived text
 * (search and prompts), `deleted` set while a delete can still be undone.
 */
export const notebookItem = sqliteTable(
  'notebook_item',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => notebookItem.id, {
      onDelete: 'cascade'
    }),
    kind: text('kind', { enum: NOTEBOOK_KINDS }).notNull(),
    title: text('title').notNull(),
    content: text('content'),
    plain: text('plain').notNull().default(''),
    position: real('position').notNull(),
    deleted: text('deleted'),
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [index('notebook_item_parent_idx').on(t.parentId, t.position)]
)
export type NotebookItemRow = typeof notebookItem.$inferSelect
export type NotebookItemInsert = typeof notebookItem.$inferInsert

/** A kept version of a notebook page (the Undo of Ms Scribe's edits; at most 20 per page). */
export const notebookVersion = sqliteTable(
  'notebook_version',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id')
      .notNull()
      .references(() => notebookItem.id, { onDelete: 'cascade' }),
    author: text('author', { enum: NOTEBOOK_AUTHORS }).notNull(),
    title: text('title').notNull(),
    content: text('content'),
    created: text('created').notNull()
  },
  (t) => [index('notebook_version_page_idx').on(t.pageId, t.created)]
)
export type NotebookVersionRow = typeof notebookVersion.$inferSelect
