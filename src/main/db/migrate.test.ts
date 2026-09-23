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
    expect(result.version).toBe(10)
    expect(tables()).toContain('project')
    expect(tables()).toContain('node')
    expect(tables()).toContain('tag')
    expect(tables()).toContain('document_tag')
    expect(tables()).toContain('ai_usage')
    expect(tables()).toContain('ai_cache')
    expect(tables()).toContain('voice_exemplar')
    expect(tables()).toContain('ai_proposal')
    expect(tables()).toContain('scene_summary')
    expect(tables()).toContain('index_job')
    expect(tables()).toContain('tag_mention')
    expect(tables()).toContain('mention_scan')
    expect(tables()).toContain('entity')
  })
})

describe('node table (0001_nodes)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })
  afterEach(() => db.close())

  const insert = (row: {
    id: string
    parentId: string | null
    sectionType: string | null
    kind?: string
  }): void => {
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, created, modified)
       VALUES (@id, @parentId, @sectionType, @kind, 'Title', 0, '2026-01-01', '2026-01-01')`
    ).run({ kind: 'folder', ...row })
  }

  it('rejects a root row without a section type', () => {
    expect(() => insert({ id: 'r', parentId: null, sectionType: null })).toThrow(
      /node_root_is_section/
    )
  })

  it('rejects a child row that carries a section type', () => {
    insert({ id: 'front', parentId: null, sectionType: 'front' })
    expect(() => insert({ id: 'c', parentId: 'front', sectionType: 'end' })).toThrow(
      /node_root_is_section/
    )
  })

  it('allows each section type only once', () => {
    insert({ id: 'a', parentId: null, sectionType: 'manuscript' })
    expect(() => insert({ id: 'b', parentId: null, sectionType: 'manuscript' })).toThrow(/UNIQUE/)
  })

  it('deletes descendants when a parent is deleted', () => {
    insert({ id: 'ms', parentId: null, sectionType: 'manuscript' })
    insert({ id: 'part', parentId: 'ms', sectionType: null })
    insert({ id: 'scene', parentId: 'part', sectionType: null, kind: 'document' })
    db.prepare('DELETE FROM node WHERE id = ?').run('part')
    const ids = (db.prepare('SELECT id FROM node ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id
    )
    expect(ids).toEqual(['ms'])
  })
})

describe('scene_summary table (0006_scene_summaries)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertSummary = (nodeId: string): void => {
    db.prepare(
      `INSERT INTO scene_summary
         (node_id, content_hash, summary, key_points, characters, prompt_version, model,
          truncated, created_at)
       VALUES (?, 'hash', 'Mara waits at the landing.', '[]', '["Mara"]', 'summary.v1',
               'gpt-fast', 0, '2026-01-01')`
    ).run(nodeId)
  }

  it('holds one row per node and refuses a summary for a node that is not there', () => {
    insertSummary('scene')
    expect(() => insertSummary('scene')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insertSummary('ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the summary with the scene: a deleted node keeps no index data', () => {
    insertSummary('scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(db.prepare('SELECT COUNT(*) AS n FROM scene_summary').get()).toEqual({ n: 0 })
  })
})

describe('index_job table (0007_index_jobs)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertJob = (id: string, nodeId: string): void => {
    db.prepare(
      `INSERT INTO index_job (id, kind, node_id, status, attempts, last_error, created_at, updated_at)
       VALUES (?, 'summary', ?, 'queued', 0, NULL, '2026-01-01', '2026-01-01')`
    ).run(id, nodeId)
  }

  it('holds one job per kind and node and refuses a job for a node that is not there', () => {
    insertJob('summary:scene', 'scene')
    expect(() => insertJob('summary:scene', 'scene')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insertJob('summary:ghost', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the job with the scene: a deleted node has nothing left to index', () => {
    insertJob('summary:scene', 'scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(db.prepare('SELECT COUNT(*) AS n FROM index_job').get()).toEqual({ n: 0 })
  })

  it('defaults attempts to 0 and leaves the last error empty', () => {
    db.prepare(
      `INSERT INTO index_job (id, kind, node_id, status, created_at, updated_at)
       VALUES ('summary:scene', 'summary', 'scene', 'queued', '2026-01-01', '2026-01-01')`
    ).run()
    expect(db.prepare('SELECT attempts, last_error FROM index_job').get()).toEqual({
      attempts: 0,
      last_error: null
    })
  })
})

describe('mentions tables (0008_mentions)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('rose', 'rose', 'character', '#dc2626', '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertMention = (id: string, tagId: string, nodeId: string): void => {
    db.prepare(
      `INSERT INTO tag_mention (id, tag_id, node_id, count, positions, updated_at)
       VALUES (?, ?, ?, 2, '[[1,5],[31,35]]', '2026-01-01')`
    ).run(id, tagId, nodeId)
  }

  it('tracks mentions for a tag created before this migration', () => {
    expect(db.prepare('SELECT track_mentions FROM tag WHERE id = ?').get('rose')).toEqual({
      track_mentions: 1
    })
  })

  it('holds one row per tag and node and refuses either end that is not there', () => {
    insertMention('rose:scene', 'rose', 'scene')
    expect(() => insertMention('rose:scene', 'rose', 'scene')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insertMention('ghost:scene', 'ghost', 'scene')).toThrow(/FOREIGN KEY/)
    expect(() => insertMention('rose:ghost', 'rose', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the mentions with the tag and with the scene', () => {
    insertMention('rose:scene', 'rose', 'scene')
    db.prepare('DELETE FROM tag WHERE id = ?').run('rose')
    expect(db.prepare('SELECT COUNT(*) AS n FROM tag_mention').get()).toEqual({ n: 0 })

    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('rain', 'rain', 'tone', '#2563eb', '2026-01-01', '2026-01-01')`
    ).run()
    insertMention('rain:scene', 'rain', 'scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(db.prepare('SELECT COUNT(*) AS n FROM tag_mention').get()).toEqual({ n: 0 })
  })

  it('keeps one scan row per node and drops it with the node', () => {
    const insertScan = (): void => {
      db.prepare(
        `INSERT INTO mention_scan (node_id, content_hash, scanned_at)
         VALUES ('scene', 'hash', '2026-01-01')`
      ).run()
    }
    insertScan()
    expect(insertScan).toThrow(/UNIQUE|PRIMARY/)
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(db.prepare('SELECT COUNT(*) AS n FROM mention_scan').get()).toEqual({ n: 0 })
  })
})

describe('entity table (0009_entities)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('rose', 'rose', 'character', '#dc2626', '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertEntity = (id: string, kind: string, name: string, tagId: string | null): void => {
    db.prepare(
      `INSERT INTO entity (id, kind, name, tag_id, created, modified)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`
    ).run(id, kind, name, tagId)
  }

  it('defaults the template to structured and the fields to an empty object', () => {
    insertEntity('ada', 'character', 'Ada', null)
    expect(
      db.prepare('SELECT template, fields, body, image, tag_id FROM entity WHERE id = ?').get('ada')
    ).toEqual({ template: 'structured', fields: '{}', body: null, image: null, tag_id: null })
  })

  it('holds the three kinds side by side under one name', () => {
    insertEntity('a', 'character', 'Marsh', null)
    insertEntity('b', 'setting', 'Marsh', null)
    insertEntity('c', 'world', 'Marsh', null)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 3 })
    // The name is not unique in SQL: the store compares `toEntityNameKey` per kind instead.
    insertEntity('d', 'character', 'marsh', null)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 4 })
  })

  it('refuses a tag that is not in the bank and clears the link when the tag goes', () => {
    expect(() => insertEntity('ghost', 'character', 'Ghost', 'missing')).toThrow(/FOREIGN KEY/)
    insertEntity('rose-entity', 'character', 'Rose', 'rose')
    db.prepare('DELETE FROM tag WHERE id = ?').run('rose')
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT tag_id FROM entity WHERE id = ?').get('rose-entity')).toEqual({
      tag_id: null
    })
  })
})
