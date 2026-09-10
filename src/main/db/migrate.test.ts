import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentVersion, loadMigrations, migrate, splitStatements } from './migrate'

const fake = {
  './migrations/0000_init.sql':
    'CREATE TABLE a (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE b (id INTEGER PRIMARY KEY);',
  './migrations/0001_add_c.sql': 'CREATE TABLE c (id INTEGER PRIMARY KEY);'
}

describe('loadMigrations', () => {
  it('orders by id and parses names', () => {
    const list = loadMigrations({
      './migrations/0001_two.sql': 'x',
      './migrations/0000_one.sql': 'y'
    })
    expect(list.map((m) => [m.id, m.name])).toEqual([
      [0, 'one'],
      [1, 'two']
    ])
  })

  it('rejects gaps in the sequence', () => {
    expect(() =>
      loadMigrations({ './migrations/0000_a.sql': '', './migrations/0002_c.sql': '' })
    ).toThrow(/contiguous/)
  })

  it('rejects badly named files', () => {
    expect(() => loadMigrations({ './migrations/init.sql': '' })).toThrow(/NNNN_name/)
  })

  it('loads the real bundled migrations', () => {
    const real = loadMigrations()
    expect(real.length).toBeGreaterThan(0)
    expect(real[0]?.id).toBe(0)
  })
})

describe('splitStatements', () => {
  it('splits on the drizzle breakpoint and drops blanks', () => {
    expect(
      splitStatements('A;\n--> statement-breakpoint\n\nB;\n--> statement-breakpoint\n')
    ).toEqual(['A;', 'B;'])
  })
})

describe('migrate', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => db.close())

  const tables = (): string[] =>
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)

  it('applies all pending migrations in order and records them', () => {
    const result = migrate(db, loadMigrations(fake))
    expect(result.applied).toEqual(['0000_init', '0001_add_c'])
    expect(result.version).toBe(2)
    expect(currentVersion(db)).toBe(2)
    expect(tables()).toEqual(['a', 'b', 'c', 'schema_migrations'])
  })

  it('is idempotent', () => {
    migrate(db, loadMigrations(fake))
    const second = migrate(db, loadMigrations(fake))
    expect(second.applied).toEqual([])
    expect(currentVersion(db)).toBe(2)
  })

  it('applies only the new migration to an older database', () => {
    migrate(
      db,
      loadMigrations({ './migrations/0000_init.sql': fake['./migrations/0000_init.sql'] })
    )
    const result = migrate(db, loadMigrations(fake))
    expect(result.applied).toEqual(['0001_add_c'])
    expect(tables()).toContain('c')
  })

  it('rolls back a failing migration and leaves the version unchanged', () => {
    migrate(
      db,
      loadMigrations({ './migrations/0000_init.sql': fake['./migrations/0000_init.sql'] })
    )
    const broken = loadMigrations({
      ...fake,
      './migrations/0001_add_c.sql':
        'CREATE TABLE c (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nTHIS IS NOT SQL;'
    })
    expect(() => migrate(db, broken)).toThrow()
    expect(tables()).not.toContain('c')
    expect(currentVersion(db)).toBe(1)
  })

  it('refuses a database migrated by a newer app', () => {
    migrate(db, loadMigrations(fake))
    const older = loadMigrations({
      './migrations/0000_init.sql': fake['./migrations/0000_init.sql']
    })
    expect(() => migrate(db, older)).toThrow(/newer version/)
  })

  it('applies the real bundled migrations to an empty database', () => {
    const result = migrate(db)
    expect(result.version).toBeGreaterThan(0)
    expect(tables()).toContain('project')
  })
})
