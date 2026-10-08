import type Database from 'better-sqlite3'

/**
 * The whole database as SQLite sees it (WAL included), as a rollback-journal file: header bytes
 * 18 and 19 say 1 instead of 2, which is what `journal_mode = DELETE` writes. The copy then needs
 * no `-wal` or `-shm` to be read; MythScribe switches it back to WAL wherever it is opened for
 * writing. Used by the cloud working copy (F-8.1) and the pre-migration backup (F-8.7).
 */
export function rollbackSnapshot(sqlite: Database.Database): Buffer {
  const data = sqlite.serialize()
  if (data.length >= 100) {
    data[18] = 1
    data[19] = 1
  }
  return data
}
