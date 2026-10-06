import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { migrate } from './migrate'

export type Orm = BetterSQLite3Database<typeof schema>

export interface Connection {
  sqlite: Database.Database
  orm: Orm
  schemaVersion: number
  close(): void
}

/** Opens (creating if needed) a project database, applies pragmas and pending migrations. */
export function openDatabase(file: string): Connection {
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
    schemaVersion = migrate(sqlite).version
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
