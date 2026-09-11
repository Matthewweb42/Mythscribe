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
