import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

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
