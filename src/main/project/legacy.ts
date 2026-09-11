import Database from 'better-sqlite3'
import path from 'node:path'
import { AppError } from '../ipc/errors'

/**
 * Detects a v0 (single-file) MythScribe database without touching it: v0 stored documents in a
 * `documents` table and had no `node` table (introduced by migration 0001). Opened read-only so a
 * legacy file is never migrated by accident (`openDatabase` would create `schema_migrations`).
 */
export function isLegacyDatabase(file: string): boolean {
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'node')"
      )
      .all()
    const names = new Set(rows.map((r) => r.name))
    return names.has('documents') && !names.has('node')
  } catch {
    throw new AppError('IO', `${path.basename(file)} is not a valid MythScribe database`, { file })
  } finally {
    db?.close()
  }
}
