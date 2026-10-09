import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../ipc/errors'
import { createProject, openProject, type ProjectSession } from '../project/projectStore'
import { migrate, type Migration, type MigrationStep } from './migrate'
import {
  listPreMigrationBackups,
  preMigrationBackupName,
  PRE_MIGRATION_KEEP,
  writePreMigrationBackup
} from './preMigrationBackup'

const fake = {
  './migrations/0000_init.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);',
  './migrations/0001_add_b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
  './migrations/0002_add_c.sql': 'CREATE TABLE c (id INTEGER PRIMARY KEY);'
}
const migrations = (count: number): Migration[] =>
  Object.entries(fake)
    .slice(0, count)
    .map(([, sql], id) => ({ id, name: ['init', 'add_b', 'add_c'][id] ?? '', sql }))

let tmp: string
const sessions: ProjectSession[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-premig-'))
})
afterEach(() => {
  for (const s of sessions.splice(0)) s.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('migrate beforeUpgrade (F-8.7)', () => {
  it('is not called for a new database or when nothing is pending', () => {
    const db = new Database(':memory:')
    const steps: MigrationStep[] = []
    migrate(db, migrations(3), { beforeUpgrade: (step) => void steps.push(step) })
    migrate(db, migrations(3), { beforeUpgrade: (step) => void steps.push(step) })
    expect(steps).toEqual([])
    db.close()
  })

  it('is called once, before the first pending migration, with the versions', () => {
    const db = new Database(':memory:')
    migrate(db, migrations(1))
    const seen: { step: MigrationStep; tables: number }[] = []
    migrate(db, migrations(3), {
      beforeUpgrade: (step) => {
        const tables = db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('b','c')"
          )
          .get() as { n: number }
        seen.push({ step, tables: tables.n })
      }
    })
    expect(seen).toEqual([{ step: { from: 1, to: 3 }, tables: 0 }])
    db.close()
  })

  it('stops the upgrade with nothing changed when it throws', () => {
    const db = new Database(':memory:')
    migrate(db, migrations(1))
    expect(() =>
      migrate(db, migrations(3), {
        beforeUpgrade: () => {
          throw new Error('no backup')
        }
      })
    ).toThrow('no backup')
    const rows = db.prepare('SELECT id FROM schema_migrations').all()
    expect(rows).toEqual([{ id: 0 }])
    db.close()
  })

  it('is not called for a database this build refuses', () => {
    const db = new Database(':memory:')
    migrate(db, migrations(3))
    let called = false
    expect(() =>
      migrate(db, migrations(2), {
        beforeUpgrade: () => {
          called = true
        }
      })
    ).toThrow(AppError)
    expect(called).toBe(false)
    db.close()
  })
})

describe('writePreMigrationBackup (F-8.7)', () => {
  it('writes a readable rollback-journal copy of a WAL database', () => {
    const file = path.join(tmp, 'live.db')
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.exec("CREATE TABLE a (v TEXT); INSERT INTO a VALUES ('kept')")
    const dir = path.join(tmp, 'backups')
    const out = writePreMigrationBackup(db, dir, { from: 1, to: 3 }, new Date(2026, 9, 8, 14, 5, 9))
    db.close()
    expect(path.basename(out)).toBe('pre-migration-1-3-2026-10-08 140509.db')
    const copy = new Database(out, { readonly: true })
    expect(copy.prepare('SELECT v FROM a').get()).toEqual({ v: 'kept' })
    copy.close()
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('keeps only the newest three and leaves other files alone', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE a (v TEXT)')
    const dir = path.join(tmp, 'backups')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'Book 2026-01-01 000000.zip'), 'zip')
    for (let day = 1; day <= 5; day++) {
      writePreMigrationBackup(db, dir, { from: day, to: day + 1 }, new Date(2026, 9, day, 9, 0, 0))
    }
    db.close()
    expect(PRE_MIGRATION_KEEP).toBe(3)
    expect(listPreMigrationBackups(dir).map((f) => path.basename(f))).toEqual([
      preMigrationBackupName({ from: 5, to: 6 }, new Date(2026, 9, 5, 9, 0, 0)),
      preMigrationBackupName({ from: 4, to: 5 }, new Date(2026, 9, 4, 9, 0, 0)),
      preMigrationBackupName({ from: 3, to: 4 }, new Date(2026, 9, 3, 9, 0, 0))
    ])
    expect(fs.existsSync(path.join(dir, 'Book 2026-01-01 000000.zip'))).toBe(true)
  })

  it('throws IO naming the folder when it cannot write', () => {
    const db = new Database(':memory:')
    const blocked = path.join(tmp, 'file-not-folder')
    fs.writeFileSync(blocked, 'x')
    let caught: unknown = null
    try {
      writePreMigrationBackup(db, path.join(blocked, 'sub'), { from: 1, to: 2 })
    } catch (err) {
      caught = err
    }
    db.close()
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe('IO')
    expect((caught as AppError).message).toContain(path.join(blocked, 'sub'))
  })
})

describe('openProject writes the backup before an upgrade (F-8.7)', () => {
  /** A real project put back to the schema before F-9.12: migrations 0021 to 0023 undone. */
  function olderProject(): { folder: string; content: string } {
    const folder = path.join(tmp, 'Book.mythscribe')
    const session = createProject(folder, 'Book', 'novel')
    session.close()
    const raw = new Database(path.join(folder, 'project.db'))
    const names = (
      raw.prepare('SELECT name FROM schema_migrations WHERE id >= 21 ORDER BY id').all() as {
        name: string
      }[]
    ).map((row) => row.name)
    expect(names).toEqual(['knowledge_index', 'passage_fts', 'facts'])
    raw.exec('DROP TABLE fact')
    raw.exec('DROP TABLE knowledge_change')
    raw.exec('ALTER TABLE entity DROP COLUMN status')
    raw.exec('DROP TABLE passage_fts')
    raw.exec('ALTER TABLE tag_mention DROP COLUMN paragraphs')
    raw.exec('ALTER TABLE mention_scan DROP COLUMN passage_hash')
    raw.prepare('DELETE FROM schema_migrations WHERE id >= 21').run()
    const content = JSON.stringify(
      raw.prepare('SELECT id, content, notes FROM node ORDER BY id').all()
    )
    raw.close()
    return { folder, content }
  }

  it('backs up the old database, then upgrades; scene text is unchanged', () => {
    const { folder, content } = olderProject()
    const backups = path.join(tmp, 'backups')
    const asked: { id: string; name: string }[] = []
    const session = openProject(folder, undefined, (project) => {
      asked.push(project)
      return backups
    })
    sessions.push(session)
    expect(asked.map((p) => p.name)).toEqual(['Book'])
    expect(asked[0]?.id).toBe(session.info.id)
    const [file] = listPreMigrationBackups(backups)
    if (file === undefined) throw new Error('no backup written')
    expect(path.basename(file)).toMatch(/^pre-migration-21-24-/)
    const copy = new Database(file, { readonly: true })
    const tables = copy.prepare("SELECT name FROM sqlite_master WHERE name = 'passage_fts'").all()
    expect(tables).toEqual([])
    copy.close()
    const after = JSON.stringify(
      session.connection.sqlite.prepare('SELECT id, content, notes FROM node ORDER BY id').all()
    )
    expect(after).toBe(content)
  })

  it('writes nothing for a project already up to date', () => {
    const folder = path.join(tmp, 'Fresh.mythscribe')
    createProject(folder, 'Fresh', 'novel').close()
    const backups = path.join(tmp, 'backups')
    sessions.push(openProject(folder, undefined, () => backups))
    expect(listPreMigrationBackups(backups)).toEqual([])
  })

  it('refuses to upgrade when the backup cannot be written, and leaves the project as it was', () => {
    const { folder } = olderProject()
    const blocked = path.join(tmp, 'file-not-folder')
    fs.writeFileSync(blocked, 'x')
    expect(() => openProject(folder, undefined, () => blocked)).toThrow(AppError)
    const raw = new Database(path.join(folder, 'project.db'), { readonly: true })
    const count = raw.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }
    raw.close()
    expect(count.n).toBe(21)
  })
})
