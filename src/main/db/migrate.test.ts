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
    expect(result.version).toBe(21)
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
    expect(tables()).toContain('observed_fact')
    expect(tables()).toContain('document_tag_dismissal')
    expect(tables()).toContain('continuity_finding')
    expect(tables()).toContain('writing_log')
    expect(tables()).toContain('draft')
    expect(tables()).toContain('draft_text')
    expect(tables()).toContain('snapshot')
    expect(tables()).toContain('snapshot_text')
    expect(tables()).toContain('context_file')
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

describe('observed_fact table and entity.origin (0010_observed_facts)', () => {
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
      `INSERT INTO entity (id, kind, name, created, modified)
       VALUES ('mara', 'character', 'Mara', '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertFact = (id: string, entityId: string, nodeId: string): void => {
    db.prepare(
      `INSERT INTO observed_fact (id, entity_id, node_id, attribute, value, quote, created_at)
       VALUES (?, ?, ?, 'age', 'nineteen', 'She was nineteen.', '2026-01-01')`
    ).run(id, entityId, nodeId)
  }
  const count = (): unknown => db.prepare('SELECT COUNT(*) AS n FROM observed_fact').get()

  it('defaults an entity to the author’s and a fact to visible', () => {
    expect(db.prepare('SELECT origin FROM entity WHERE id = ?').get('mara')).toEqual({
      origin: 'author'
    })
    insertFact('f1', 'mara', 'scene')
    expect(db.prepare('SELECT hidden FROM observed_fact WHERE id = ?').get('f1')).toEqual({
      hidden: 0
    })
  })

  it('refuses a fact about an unknown entity or scene', () => {
    expect(() => insertFact('f1', 'ghost', 'scene')).toThrow(/FOREIGN KEY/)
    expect(() => insertFact('f1', 'mara', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the facts with their entity and with their scene', () => {
    insertFact('f1', 'mara', 'scene')
    db.prepare('DELETE FROM entity WHERE id = ?').run('mara')
    expect(count()).toEqual({ n: 0 })
    db.prepare(
      `INSERT INTO entity (id, kind, name, created, modified)
       VALUES ('mara', 'character', 'Mara', '2026-01-01', '2026-01-01')`
    ).run()
    insertFact('f2', 'mara', 'scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count()).toEqual({ n: 0 })
  })
})

describe('document_tag.source, tag.origin, and document_tag_dismissal (0011_auto_tags)', () => {
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
       VALUES ('dread', 'dread', 'tone', '#2563eb', '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const dismiss = (nodeId: string, tagId: string): void => {
    db.prepare('INSERT INTO document_tag_dismissal (node_id, tag_id) VALUES (?, ?)').run(
      nodeId,
      tagId
    )
  }
  const count = (): unknown => db.prepare('SELECT COUNT(*) AS n FROM document_tag_dismissal').get()

  it('defaults a tag and a link to the author’s', () => {
    expect(db.prepare('SELECT origin FROM tag WHERE id = ?').get('dread')).toEqual({
      origin: 'author'
    })
    db.prepare(
      `INSERT INTO document_tag (id, node_id, tag_id, created)
       VALUES ('l1', 'scene', 'dread', '2026-01-01')`
    ).run()
    expect(db.prepare('SELECT source FROM document_tag WHERE id = ?').get('l1')).toEqual({
      source: 'author'
    })
  })

  it('keeps one dismissal per pair and refuses an unknown node or tag', () => {
    dismiss('scene', 'dread')
    expect(() => dismiss('scene', 'dread')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => dismiss('ghost', 'dread')).toThrow(/FOREIGN KEY/)
    expect(() => dismiss('scene', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the dismissal with its tag and with its node', () => {
    dismiss('scene', 'dread')
    db.prepare('DELETE FROM tag WHERE id = ?').run('dread')
    expect(count()).toEqual({ n: 0 })
    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('dread', 'dread', 'tone', '#2563eb', '2026-01-01', '2026-01-01')`
    ).run()
    dismiss('scene', 'dread')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count()).toEqual({ n: 0 })
  })
})

describe('continuity_finding table (0012_continuity_findings)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '2026-01-01', '2026-01-01'),
              ('other', 'ms', NULL, 'document', 'Scene 2', 1, '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO entity (id, kind, name, created, modified)
       VALUES ('mara', 'character', 'Mara', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO ai_proposal (id, created_at, feature, node_id, prompt_version, model,
         prompt_tokens, completion_tokens, cost_usd, cached, content)
       VALUES ('p1', '2026-01-01', 'continuity', 'scene', 'continuity.v1', 'gpt', 1, 1, 0, 0, '[]')`
    ).run()
  })
  afterEach(() => db.close())

  const insertFinding = (id: string, nodeId = 'scene', entityId: string | null = 'mara'): void => {
    db.prepare(
      `INSERT INTO continuity_finding (id, node_id, ref_kind, entity_id, entity_name, entity_kind,
         attribute, ref_label, ref_value, ref_node_id, ref_quote, quote, why, origin, dedupe_key,
         proposal_id, created_at)
       VALUES (?, ?, 'fact', ?, 'Mara', 'character', 'age', 'Age', '34', 'other',
         'She was thirty-four.', 'Mara was twenty-nine.', 'Both cannot be true.', 'background',
         'k', 'p1', '2026-01-01')`
    ).run(id, nodeId, entityId)
  }
  const row = (id: string): unknown =>
    db
      .prepare(
        'SELECT status, flagged, fix, ref_node_id, proposal_id FROM continuity_finding WHERE id = ?'
      )
      .get(id)
  const count = (): unknown => db.prepare('SELECT COUNT(*) AS n FROM continuity_finding').get()

  it('defaults a finding to open and unflagged, with no fix', () => {
    insertFinding('f1')
    expect(row('f1')).toEqual({
      status: 'open',
      flagged: 0,
      fix: null,
      ref_node_id: 'other',
      proposal_id: 'p1'
    })
  })

  it('refuses a finding about an unknown scene or entity, and takes one with no entity (a timeline)', () => {
    expect(() => insertFinding('f1', 'ghost')).toThrow(/FOREIGN KEY/)
    expect(() => insertFinding('f1', 'scene', 'ghost')).toThrow(/FOREIGN KEY/)
    insertFinding('f1', 'scene', null)
    expect(count()).toEqual({ n: 1 })
  })

  it('drops the findings with their scene and with their entity', () => {
    insertFinding('f1')
    db.prepare('DELETE FROM entity WHERE id = ?').run('mara')
    expect(count()).toEqual({ n: 0 })
    insertFinding('f2', 'scene', null)
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count()).toEqual({ n: 0 })
  })

  it('keeps a finding whose referenced scene or proposal is gone, with the link cleared', () => {
    insertFinding('f1')
    db.prepare('DELETE FROM node WHERE id = ?').run('other')
    db.prepare('DELETE FROM ai_proposal WHERE id = ?').run('p1')
    expect(row('f1')).toMatchObject({ ref_node_id: null, proposal_id: null })
  })
})

describe('writing_log table (0013_writing_log)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
  })
  afterEach(() => db.close())

  it('defaults words and active time to 0', () => {
    db.prepare("INSERT INTO writing_log (day, hour) VALUES ('2026-10-04', 9)").run()
    expect(db.prepare('SELECT words, active_ms FROM writing_log').get()).toEqual({
      words: 0,
      active_ms: 0
    })
  })

  it('keeps one bucket per day and hour, and takes a negative hour of cutting', () => {
    const insert = db.prepare('INSERT INTO writing_log (day, hour, words) VALUES (?, ?, ?)')
    insert.run('2026-10-04', 9, 120)
    insert.run('2026-10-04', 10, -40)
    insert.run('2026-10-05', 9, 10)
    expect(() => insert.run('2026-10-04', 9, 5)).toThrow(/UNIQUE|PRIMARY KEY/)
    expect(db.prepare('SELECT SUM(words) AS n FROM writing_log').get()).toEqual({ n: 90 })
  })

  it('refuses a bucket without a day or an hour', () => {
    expect(() => db.prepare('INSERT INTO writing_log (day, hour) VALUES (NULL, 1)').run()).toThrow(
      /NOT NULL/
    )
    expect(() =>
      db.prepare("INSERT INTO writing_log (day, hour) VALUES ('2026-10-04', NULL)").run()
    ).toThrow(/NOT NULL/)
  })
})

describe('draft and draft_text tables (0014_drafts)', () => {
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
      `INSERT INTO draft (id, name, position, created, modified)
       VALUES ('d1', 'Draft 1', 0, '2026-01-01', '2026-01-01')`
    ).run()
  })
  afterEach(() => db.close())

  const insertText = (draftId: string, nodeId: string): void => {
    db.prepare('INSERT INTO draft_text (draft_id, node_id, content) VALUES (?, ?, NULL)').run(
      draftId,
      nodeId
    )
  }
  const count = (): unknown => db.prepare('SELECT COUNT(*) AS n FROM draft_text').get()

  it('keeps one text per draft and node, defaults words to 0, and refuses unknown ends', () => {
    insertText('d1', 'scene')
    expect(db.prepare('SELECT word_count FROM draft_text').get()).toEqual({ word_count: 0 })
    expect(() => insertText('d1', 'scene')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insertText('ghost', 'scene')).toThrow(/FOREIGN KEY/)
    expect(() => insertText('d1', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops the texts with their draft and with their node', () => {
    insertText('d1', 'scene')
    db.prepare('DELETE FROM draft WHERE id = ?').run('d1')
    expect(count()).toEqual({ n: 0 })
    db.prepare(
      `INSERT INTO draft (id, name, position, created, modified)
       VALUES ('d1', 'Draft 1', 0, '2026-01-01', '2026-01-01')`
    ).run()
    insertText('d1', 'scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count()).toEqual({ n: 0 })
  })
})

describe('snapshot and snapshot_text tables (0015_snapshots)', () => {
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

  const insertSnapshot = (id: string, nodeId: string | null): void => {
    db.prepare(
      `INSERT INTO snapshot (id, name, kind, scope, node_id, created)
       VALUES (?, 'Snap', 'manual', ?, ?, '2026-01-01')`
    ).run(id, nodeId === null ? 'project' : 'document', nodeId)
  }
  const insertText = (snapshotId: string, nodeId: string): void => {
    db.prepare('INSERT INTO snapshot_text (snapshot_id, node_id, content) VALUES (?, ?, NULL)').run(
      snapshotId,
      nodeId
    )
  }
  const count = (table: string): unknown => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()

  it('defaults the note and word count, keeps one text per node, and refuses unknown ends', () => {
    insertSnapshot('s1', null)
    expect(db.prepare('SELECT note, draft_name FROM snapshot').get()).toEqual({
      note: '',
      draft_name: null
    })
    insertText('s1', 'scene')
    expect(db.prepare('SELECT word_count FROM snapshot_text').get()).toEqual({ word_count: 0 })
    expect(() => insertText('s1', 'scene')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => insertText('ghost', 'scene')).toThrow(/FOREIGN KEY/)
    expect(() => insertText('s1', 'ghost')).toThrow(/FOREIGN KEY/)
    expect(() => insertSnapshot('s2', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops texts with their snapshot, and texts and document snapshots with their node', () => {
    insertSnapshot('s1', null)
    insertText('s1', 'scene')
    db.prepare('DELETE FROM snapshot WHERE id = ?').run('s1')
    expect(count('snapshot_text')).toEqual({ n: 0 })

    insertSnapshot('s1', null)
    insertSnapshot('s2', 'scene')
    insertText('s1', 'scene')
    insertText('s2', 'scene')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count('snapshot_text')).toEqual({ n: 0 })
    expect(db.prepare('SELECT id FROM snapshot').all()).toEqual([{ id: 's1' }])
  })
})

describe('voice_exemplar.source (0016_voice_exemplar_source)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
  })
  afterEach(() => db.close())

  const insert = (id: string, source?: string): void => {
    if (source === undefined) {
      db.prepare(
        `INSERT INTO voice_exemplar (id, node_id, text, pov, kind, created)
         VALUES (?, NULL, 'text', NULL, 'mixed', '2026-01-01')`
      ).run(id)
      return
    }
    db.prepare(
      `INSERT INTO voice_exemplar (id, node_id, text, pov, kind, created, source)
       VALUES (?, NULL, 'text', NULL, 'mixed', '2026-01-01', ?)`
    ).run(id, source)
  }

  it('defaults a row written without a source (every row marked before F-14.14) to the author’s', () => {
    insert('e1')
    insert('e2', 'auto')
    expect(db.prepare('SELECT id, source FROM voice_exemplar ORDER BY id').all()).toEqual([
      { id: 'e1', source: 'author' },
      { id: 'e2', source: 'auto' }
    ])
  })

  it('refuses a null source', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO voice_exemplar (id, node_id, text, pov, kind, created, source)
           VALUES ('e3', NULL, 'text', NULL, 'mixed', '2026-01-01', NULL)`
        )
        .run()
    ).toThrow(/NOT NULL/)
  })
})

describe('edit_pass and edit_change tables (0017_edit_passes)', () => {
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
      `INSERT INTO ai_proposal (id, created_at, feature, node_id, prompt_version, model,
         prompt_tokens, completion_tokens, cost_usd, cached, content)
       VALUES ('p1', '2026-01-01', 'editPass', 'scene', 'editPass.v1', 'gpt', 1, 1, 0, 0, '[]')`
    ).run()
  })
  afterEach(() => db.close())

  const insertPass = (id: string): void => {
    db.prepare(
      `INSERT INTO edit_pass (id, type, status, node_ids, created_at)
       VALUES (?, 'line', 'running', '["scene"]', '2026-01-01')`
    ).run(id)
  }
  const insertChange = (id: string, passId = 'e1', nodeId = 'scene'): void => {
    db.prepare(
      `INSERT INTO edit_change (id, pass_id, node_id, kind, position, original, replacement,
         rationale, proposal_id)
       VALUES (?, ?, ?, 'change', 0, 'He walked slowly.', 'He trudged.', 'Stronger verb.', 'p1')`
    ).run(id, passId, nodeId)
  }
  const count = (table: string): unknown => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()

  it('defaults a pass to no progress and no cost, and a change to pending and unflagged', () => {
    insertPass('e1')
    expect(
      db
        .prepare(
          'SELECT done_node_ids, model, tokens_in, tokens_out, cost_usd, dropped, error, finished_at FROM edit_pass'
        )
        .get()
    ).toEqual({
      done_node_ids: '[]',
      model: '',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      dropped: 0,
      error: null,
      finished_at: null
    })
    insertChange('c1')
    expect(db.prepare('SELECT status, flagged, category FROM edit_change').get()).toEqual({
      status: 'pending',
      flagged: 0,
      category: null
    })
    expect(() => insertChange('c2', 'ghost')).toThrow(/FOREIGN KEY/)
    expect(() => insertChange('c3', 'e1', 'ghost')).toThrow(/FOREIGN KEY/)
  })

  it('drops changes with their pass and with their scene, and keeps them when the proposal goes', () => {
    insertPass('e1')
    insertChange('c1')
    db.prepare('DELETE FROM ai_proposal WHERE id = ?').run('p1')
    expect(db.prepare('SELECT proposal_id FROM edit_change').get()).toEqual({ proposal_id: null })
    db.prepare('DELETE FROM edit_pass WHERE id = ?').run('e1')
    expect(count('edit_change')).toEqual({ n: 0 })

    insertPass('e2')
    db.prepare(
      `INSERT INTO ai_proposal (id, created_at, feature, node_id, prompt_version, model,
         prompt_tokens, completion_tokens, cost_usd, cached, content)
       VALUES ('p1', '2026-01-01', 'editPass', 'scene', 'editPass.v1', 'gpt', 1, 1, 0, 0, '[]')`
    ).run()
    insertChange('c2', 'e2')
    db.prepare('DELETE FROM node WHERE id = ?').run('scene')
    expect(count('edit_change')).toEqual({ n: 0 })
    expect(count('edit_pass')).toEqual({ n: 1 })
  })
})

describe('tag.aliases and entity.aliases (0019_aliases)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })
  afterEach(() => db.close())

  it('gives every tag and entity written before F-4.14 an empty list, and refuses a null one', () => {
    migrate(db, loadMigrations().slice(0, 19))
    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('t1', 'rynna', 'character', '#dc2626', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO entity (id, kind, name, created, modified)
       VALUES ('e1', 'character', 'Rynna', '2026-01-01', '2026-01-01')`
    ).run()
    migrate(db)
    expect(db.prepare('SELECT aliases FROM tag').get()).toEqual({ aliases: '[]' })
    expect(db.prepare('SELECT aliases FROM entity').get()).toEqual({ aliases: '[]' })
    expect(() => db.prepare('UPDATE tag SET aliases = NULL').run()).toThrow(/NOT NULL/)
  })
})

describe('story_category (0020_story_categories)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })
  afterEach(() => db.close())

  it('keeps every sheet written before F-9.11 under its kind (now a library category id) and starts with no project categories', () => {
    migrate(db, loadMigrations().slice(0, 20))
    const insert = db.prepare(
      `INSERT INTO entity (id, kind, name, created, modified) VALUES (?, ?, ?, '2026-01-01', '2026-01-01')`
    )
    insert.run('e1', 'character', 'Rynna')
    insert.run('e2', 'setting', 'Kael')
    insert.run('e3', 'world', 'The Weave')
    migrate(db)
    expect(db.prepare('SELECT id, kind FROM entity ORDER BY id').all()).toEqual([
      { id: 'e1', kind: 'character' },
      { id: 'e2', kind: 'setting' },
      { id: 'e3', kind: 'world' }
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM story_category').get()).toEqual({ n: 0 })
    db.prepare(
      `INSERT INTO story_category (id, name, noun, icon, origin, created, modified)
       VALUES ('setting', 'Locations', 'location', 'map-pin', 'author', '2026-01-01', '2026-01-01')`
    ).run()
    expect(db.prepare('SELECT hint, fields FROM story_category').get()).toEqual({
      hint: '',
      fields: null
    })
  })
})
