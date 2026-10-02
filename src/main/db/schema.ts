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
import { ENTITY_KINDS, ENTITY_ORIGINS, ENTITY_TEMPLATES } from '../../shared/entities'
import { PROPOSAL_STATUSES } from '../../shared/proposal'
import { HIERARCHY_LEVELS, NODE_KINDS, SECTION_TYPES } from '../../shared/labels'
import { TAG_CATEGORIES } from '../../shared/tags'
import { EXEMPLAR_KINDS } from '../../shared/voice'

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
    contextHash: text('context_hash').notNull()
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
    created: text('created').notNull()
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
  createdAt: text('created_at').notNull()
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
  scannedAt: text('scanned_at').notNull()
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
    kind: text('kind', { enum: ENTITY_KINDS }).notNull(),
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
    created: text('created').notNull(),
    modified: text('modified').notNull()
  },
  (t) => [index('entity_kind_name_idx').on(t.kind, t.name)]
)
export type EntityRow = typeof entity.$inferSelect
export type EntityInsert = typeof entity.$inferInsert

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
