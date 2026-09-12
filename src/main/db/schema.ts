import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
// Relative on purpose: drizzle-kit loads this file without the `@shared` path alias.
import { HIERARCHY_LEVELS, NODE_KINDS, SECTION_TYPES } from '../../shared/labels'
import { TAG_CATEGORIES } from '../../shared/tags'

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
