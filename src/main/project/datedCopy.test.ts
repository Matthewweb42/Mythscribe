import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { datedCopyPath, saveDatedCopy } from './datedCopy'
import { OPEN_LOCK_FILE } from './openLock'
import { RECOVERY_DIR } from './recoveryJournal'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-dated-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const NOW = new Date(2026, 9, 11, 14, 30)

/** A project folder with its database, an asset, and the files a copy must leave behind. */
function project(): string {
  const folder = path.join(tmp, 'Novel.mythscribe')
  fs.mkdirSync(path.join(folder, 'assets', 'library'), { recursive: true })
  fs.mkdirSync(path.join(folder, RECOVERY_DIR), { recursive: true })
  fs.writeFileSync(path.join(folder, 'project.db'), 'db')
  fs.writeFileSync(path.join(folder, 'project.db-wal'), 'wal')
  fs.writeFileSync(path.join(folder, 'project.db-shm'), 'shm')
  fs.writeFileSync(path.join(folder, 'assets', 'library', 'notes.md'), 'notes')
  fs.writeFileSync(path.join(folder, OPEN_LOCK_FILE), 'lock')
  fs.writeFileSync(path.join(folder, RECOVERY_DIR, 'journal.json'), '{}')
  fs.writeFileSync(path.join(folder, 'project.db.sync-1.tmp'), 'tmp')
  return folder
}

describe('saveDatedCopy (F-16.15, generalised from the conflict copy)', () => {
  it('names the copy with its label and the time, numbered when taken', () => {
    const folder = project()
    expect(path.basename(datedCopyPath(folder, NOW, 'before story memory'))).toBe(
      'Novel (before story memory 2026-10-11 1430).mythscribe'
    )
    const first = saveDatedCopy(folder, NOW, 'before story memory')
    const second = saveDatedCopy(folder, NOW, 'before story memory')
    expect(path.basename(first)).toBe('Novel (before story memory 2026-10-11 1430).mythscribe')
    expect(path.basename(second)).toBe('Novel (before story memory 2026-10-11 1430) 2.mythscribe')
  })

  it('copies the database and assets, never the open marker, journal, -shm or temp files', () => {
    const copy = saveDatedCopy(project(), NOW, 'story memory test')
    expect(fs.readFileSync(path.join(copy, 'project.db'), 'utf8')).toBe('db')
    expect(fs.readFileSync(path.join(copy, 'project.db-wal'), 'utf8')).toBe('wal')
    expect(fs.readFileSync(path.join(copy, 'assets', 'library', 'notes.md'), 'utf8')).toBe('notes')
    expect(fs.existsSync(path.join(copy, OPEN_LOCK_FILE))).toBe(false)
    expect(fs.existsSync(path.join(copy, RECOVERY_DIR))).toBe(false)
    expect(fs.existsSync(path.join(copy, 'project.db-shm'))).toBe(false)
    expect(fs.existsSync(path.join(copy, 'project.db.sync-1.tmp'))).toBe(false)
  })

  it('puts a stand-in database in place of the folder’s own and its -wal', () => {
    const snapshot = path.join(tmp, 'snapshot.db')
    fs.writeFileSync(snapshot, 'snapshot')
    const copy = saveDatedCopy(project(), NOW, 'story memory test', { database: snapshot })
    expect(fs.readFileSync(path.join(copy, 'project.db'), 'utf8')).toBe('snapshot')
    expect(fs.existsSync(path.join(copy, 'project.db-wal'))).toBe(false)
  })

  it('leaves nothing behind and says why when the copy fails', () => {
    const folder = project()
    const missing = path.join(tmp, 'gone.db')
    expect(() =>
      saveDatedCopy(folder, NOW, 'before story memory', {
        database: missing,
        failure: 'Could not keep a copy'
      })
    ).toThrow(/^Could not keep a copy: /)
    expect(fs.readdirSync(tmp).filter((name) => name.includes('before story memory'))).toEqual([])
  })
})
