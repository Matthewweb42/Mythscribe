import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isLegacyDatabase } from './legacy'
import { createProject, projectFolderFor } from './projectStore'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-legacy-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('isLegacyDatabase', () => {
  it('recognises a v0 database by its documents table and missing node table', () => {
    const file = path.join(tmp, 'Old.mythscribe')
    const db = new Database(file)
    db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT)')
    db.exec('CREATE TABLE project (id TEXT PRIMARY KEY)')
    db.close()
    expect(isLegacyDatabase(file)).toBe(true)
    // Read-only probe: the file was not migrated.
    const check = new Database(file, { readonly: true })
    const tables = check
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    check.close()
    expect(tables).not.toContain('schema_migrations')
  })

  it('reports a v1 project database as current', () => {
    const folder = projectFolderFor(tmp, 'New')
    createProject(folder, 'New', 'novel').close()
    expect(isLegacyDatabase(path.join(folder, 'project.db'))).toBe(false)
  })

  it('checks a WAL database with a leftover -wal on a copy, leaving no -shm beside it', () => {
    const file = path.join(tmp, 'project.db')
    const writer = new Database(file)
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    writer.exec('CREATE TABLE node (id TEXT PRIMARY KEY)')
    // Copy the files while the writer is open, as a crashed build leaves them.
    const crashed = path.join(tmp, 'crashed')
    fs.mkdirSync(crashed)
    const db = path.join(crashed, 'project.db')
    fs.copyFileSync(file, db)
    fs.copyFileSync(`${file}-wal`, `${db}-wal`)
    writer.close()
    expect(isLegacyDatabase(db)).toBe(false)
    expect(fs.readdirSync(crashed).sort()).toEqual(['project.db', 'project.db-wal'])
  })

  it('throws IO for a file that is not SQLite', () => {
    const file = path.join(tmp, 'text.mythscribe')
    fs.writeFileSync(file, 'this is not a database')
    expect(() => isLegacyDatabase(file)).toThrowError(expect.objectContaining({ code: 'IO' }))
    expect(() => isLegacyDatabase(file)).toThrowError(/not a valid/)
  })

  it('throws IO for a missing file', () => {
    expect(() => isLegacyDatabase(path.join(tmp, 'missing.db'))).toThrowError(
      expect.objectContaining({ code: 'IO' })
    )
  })
})
