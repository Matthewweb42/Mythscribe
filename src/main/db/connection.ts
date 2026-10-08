import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { migrate, type MigrationStep } from './migrate'

export type Orm = BetterSQLite3Database<typeof schema>

export interface Connection {
  sqlite: Database.Database
  orm: Orm
  schemaVersion: number
  close(): void
}

export interface OpenDatabaseOptions {
  /**
   * Runs before a schema upgrade of a database that already has a schema (F-8.7: the
   * pre-migration backup). A throw closes the database unchanged and is rethrown.
   */
  beforeUpgrade?: (sqlite: Database.Database, step: MigrationStep) => void
}

/** Opens (creating if needed) a project database, applies pragmas and pending migrations. */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Connection {
  const sqlite = new Database(file)
  // Exclusive locking before WAL (decided 2026-10-06): SQLite then keeps the WAL index in memory
  // instead of a memory-mapped `-shm` file, which Google Drive and other virtual drives cannot
  // serve (the "disk I/O error" the author hit). One connection per project is all the app uses.
  sqlite.pragma('locking_mode = EXCLUSIVE')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  let schemaVersion: number
  try {
    const { beforeUpgrade } = options
    schemaVersion = migrate(sqlite, undefined, {
      beforeUpgrade: beforeUpgrade && ((step) => beforeUpgrade(sqlite, step))
    }).version
  } catch (err) {
    sqlite.close()
    throw err
  }
  const orm = drizzle(sqlite, { schema })
  return {
    sqlite,
    orm,
    schemaVersion,
    close: () => sqlite.close()
  }
}
