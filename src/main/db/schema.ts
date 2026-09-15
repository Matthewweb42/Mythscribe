import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
// Relative on purpose: drizzle-kit loads this file without the `@shared` path alias.
import { AI_PROVIDER_IDS } from '../../shared/ai'
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
