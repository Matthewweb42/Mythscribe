import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppError } from '../ipc/errors'

/**
 * Detects a v0 (single-file) MythScribe database without touching it: v0 stored documents in a
 * `documents` table and had no `node` table (introduced by migration 0001). Opened read-only so a
 * legacy file is never migrated by accident (`openDatabase` would create `schema_migrations`).
 *
 * 2026-10-08: a database in WAL mode (every project the pre-working-copy builds wrote) or with a
 * `-wal` beside it is checked on a temporary local copy: even a read-only open of it makes SQLite
 * create and map a `-shm` next to the file, which fails on a cloud drive (SQLITE_IOERR on Google
 * Drive for desktop) and would make the project impossible to open.
 */
export function isLegacyDatabase(file: string): boolean {
  if (!needsLocalCopy(file)) return checkTables(file)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-check-'))
  try {
    const copy = path.join(dir, 'check.db')
    try {
      fs.copyFileSync(file, copy)
      if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`)
    } catch {
      throw new AppError('IO', `${path.basename(file)} could not be read`, { file })
    }
    return checkTables(copy, file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** True when opening the file in place would make SQLite touch `-wal`/`-shm` files beside it. */
function needsLocalCopy(file: string): boolean {
  if (fs.existsSync(`${file}-wal`)) return true
  const header = Buffer.alloc(19)
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, header, 0, 19, 0)
  } catch {
    return false
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
  // Header byte 18 is the file format write version: 2 means WAL mode.
  return header[18] === 2
}

function checkTables(file: string, shown = file): boolean {
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
    throw new AppError('IO', `${path.basename(shown)} is not a valid MythScribe database`, {
      file: shown
    })
  } finally {
    db?.close()
  }
}
