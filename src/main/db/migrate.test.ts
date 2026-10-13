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
    expect(result.version).toBe(39)
    expect(tables()).toContain('project')
    expect(tables()).toContain('todo_item')
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
    expect(tables()).toContain('passage_fts')
    for (const table of [
      'record',
      'alias',
      'label',
      'label_link',
      'dismissed',
      'author_todo',
      'scene_detail',
      'name_mention',
      'memory_scan',
      'memory_passage_fts',
      'reading',
      'scene_read',
      'card',
      'claim',
      'plan_link',
      'memory_backfill',
      'finding',
      'verdict_cache'
    ]) {
      expect(tables()).toContain(table)
    }
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

describe('tag_mention.paragraphs, mention_scan.passage_hash, passage_fts (0021, 0022)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-9.12 left it: migrations up to 0020, with a scan on record.
    migrate(db, loadMigrations().slice(0, 21))
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, NULL, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '{"type":"doc"}', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO tag (id, name, category, color, created, modified)
       VALUES ('rose', 'rose', 'character', '#dc2626', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO tag_mention (id, tag_id, node_id, count, positions, updated_at)
       VALUES ('rose:scene', 'rose', 'scene', 1, '[[1,5]]', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO mention_scan (node_id, content_hash, scanned_at) VALUES ('scene', 'h', '2026-01-01')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('keeps every row of a 0020 database, with no paragraphs and no passage hash yet', () => {
    expect(db.prepare('SELECT positions, paragraphs FROM tag_mention').get()).toEqual({
      positions: '[[1,5]]',
      paragraphs: '[]'
    })
    expect(db.prepare('SELECT content_hash, passage_hash FROM mention_scan').get()).toEqual({
      content_hash: 'h',
      passage_hash: null
    })
    expect(db.prepare('SELECT content FROM node WHERE id = ?').get('scene')).toEqual({
      content: '{"type":"doc"}'
    })
  })

  it('creates an empty full-text table that stems and folds diacritics', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM passage_fts').get()).toEqual({ n: 0 })
    db.prepare("INSERT INTO passage_fts (node_id, para, text) VALUES ('scene', 0, ?)").run(
      'Mara was running past the café.'
    )
    const hits = (query: string): number =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM passage_fts WHERE passage_fts MATCH ?')
          .get(query) as {
          n: number
        }
      ).n
    expect(hits('"runs"')).toBe(1)
    expect(hits('"cafe"')).toBe(1)
    expect(hits('"mara"')).toBe(1)
    expect(hits('"lantern"')).toBe(0)
  })
})

describe('fact, knowledge_change, entity.status (0023)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-9.13 left it: migrations up to 0022, with a sheet, a
    // scene, and an observed fact on record.
    migrate(db, loadMigrations().slice(0, 23))
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, NULL, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '{"type":"doc"}', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO entity (id, kind, name, fields, created, modified)
       VALUES ('mara', 'character', 'Mara', '{"age":"31"}', '2026-01-01', '2026-01-01')`
    ).run()
    db.prepare(
      `INSERT INTO observed_fact (id, entity_id, node_id, attribute, value, quote, created_at)
       VALUES ('f1', 'mara', 'scene', 'appearance', 'Grey eyes', 'grey eyes', '2026-01-02')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('keeps every row of a 0022 database, adds empty tables, and makes every sheet canon', () => {
    expect(db.prepare('SELECT fields, status FROM entity').get()).toEqual({
      fields: '{"age":"31"}',
      status: 'canon'
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM observed_fact').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_change').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT content FROM node WHERE id = ?').get('scene')).toEqual({
      content: '{"type":"doc"}'
    })
  })

  it('keeps a fact key unique per record, and keeps an author line when its scene goes', () => {
    const insert = db.prepare(
      `INSERT INTO fact (id, entity_id, attribute, value, node_id, origin, fact_key, created_at, updated_at)
       VALUES (?, 'mara', 'age', '34', 'scene', 'author', 'k', '2026-01-03', '2026-01-03')`
    )
    insert.run('a')
    expect(() => insert.run('b')).toThrow(/UNIQUE/)
    db.prepare("DELETE FROM node WHERE id = 'scene'").run()
    expect(db.prepare('SELECT node_id, status, hidden FROM fact').get()).toEqual({
      node_id: null,
      status: 'canon',
      hidden: 0
    })
  })
})

describe('todo_item (0025)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-9.16 left it: migrations up to 0024, with a scene.
    migrate(db, loadMigrations().slice(0, 25))
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, NULL, '2026-01-01', '2026-01-01'),
              ('scene', 'ms', NULL, 'document', 'Scene 1', 0, '{"type":"doc"}', '2026-01-01', '2026-01-01')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('opens a 0024 database with an empty table and every scene as it was', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM todo_item').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT content FROM node WHERE id = ?').get('scene')).toEqual({
      content: '{"type":"doc"}'
    })
  })

  it('keeps one row per key, and keeps a row whose scene was deleted', () => {
    const insert = db.prepare(
      `INSERT INTO todo_item (id, key, kind, rule, source, subject, node_id, why, target, created_at, updated_at)
       VALUES (?, 'timeline:x', 'gap', 'timeline', 'ai', 'X', 'scene', 'why', '{"kind":"none"}', '2026-01-02', '2026-01-02')`
    )
    insert.run('a')
    expect(() => insert.run('b')).toThrow(/UNIQUE/)
    db.prepare("DELETE FROM node WHERE id = 'scene'").run()
    expect(db.prepare('SELECT node_id, status, suggestions FROM todo_item').get()).toEqual({
      node_id: null,
      status: 'open',
      suggestions: '[]'
    })
  })
})

describe('entity.extra_fields and entity.sync (0026)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-9.18 left it: migrations up to 0025, with two sheets.
    migrate(db, loadMigrations().slice(0, 26))
    db.prepare(
      `INSERT INTO entity (id, kind, name, template, fields, body, created, modified)
       VALUES ('mara', 'character', 'Mara', 'structured', '{"age":"27"}', NULL, '2026-01-01', '2026-01-01'),
              ('kael', 'character', 'Kael', 'blank', '{}', 'Kael is a smuggler.', '2026-01-01', '2026-01-01')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('keeps every sheet as written, with no field of its own and never synced', () => {
    expect(
      db.prepare('SELECT id, fields, body, extra_fields, sync FROM entity ORDER BY id').all()
    ).toEqual([
      { id: 'kael', fields: '{}', body: 'Kael is a smuggler.', extra_fields: '[]', sync: null },
      { id: 'mara', fields: '{"age":"27"}', body: null, extra_fields: '[]', sync: null }
    ])
  })

  it('refuses a null list of the sheet’s own fields', () => {
    expect(() =>
      db.prepare("UPDATE entity SET extra_fields = NULL WHERE id = 'mara'").run()
    ).toThrow(/NOT NULL/)
  })
})

describe('edit_pass.excerpt (0027)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-5.26 left it: migrations up to 0026, with one pass.
    migrate(db, loadMigrations().slice(0, 27))
    db.prepare(
      `INSERT INTO edit_pass (id, type, instruction, status, node_ids, created_at)
       VALUES ('p1', 'line', NULL, 'done', '["s1"]', '2026-01-01')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('keeps every pass as written, over whole scenes', () => {
    expect(db.prepare('SELECT id, type, node_ids, excerpt FROM edit_pass').all()).toEqual([
      { id: 'p1', type: 'line', node_ids: '["s1"]', excerpt: null }
    ])
  })

  it('stores the selected passage a one-scene pass reads', () => {
    db.prepare(
      `INSERT INTO edit_pass (id, type, instruction, status, node_ids, excerpt, created_at)
       VALUES ('p2', 'proofread', NULL, 'running', '["s1"]', 'The bell rang.', '2026-01-02')`
    ).run()
    expect(db.prepare("SELECT excerpt FROM edit_pass WHERE id = 'p2'").get()).toEqual({
      excerpt: 'The bell rang.'
    })
  })
})

describe('ai_usage.reported_cost_usd and reasoning_tokens (0028, F-16.1)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A database as the build before F-16.1 left it: migrations up to 0027, with one ledger row.
    migrate(db, loadMigrations().slice(0, 28))
    db.prepare(
      `INSERT INTO ai_usage (id, at, feature, tier, model, provider, prompt_tokens,
         completion_tokens, cached_tokens, cost_usd, cached, prompt_version, context_hash)
       VALUES ('u1', '2026-10-01T10:00:00.000Z', 'summary', 'fast', 'deepseek/deepseek-v4-flash',
         'openrouter', 1200, 300, NULL, 0.0004, 0, 'summary.v5', 'ctx')`
    ).run()
    migrate(db)
  })
  afterEach(() => db.close())

  it('keeps every ledger row, with no reported cost and no reasoning tokens', () => {
    expect(
      db.prepare('SELECT id, cost_usd, reported_cost_usd, reasoning_tokens FROM ai_usage').all()
    ).toEqual([{ id: 'u1', cost_usd: 0.0004, reported_cost_usd: null, reasoning_tokens: null }])
  })

  it('stores a reported cost and the thinking tokens on a new row', () => {
    db.prepare(
      `INSERT INTO ai_usage (id, at, feature, tier, model, provider, prompt_tokens,
         completion_tokens, cost_usd, cached, context_hash, reported_cost_usd, reasoning_tokens)
       VALUES ('u2', '2026-10-11T10:00:00.000Z', 'agent', 'strong', 'deepseek/deepseek-v4-pro',
         'openrouter', 5000, 400, 0.0101, 0, 'ctx2', 0.0101, 250)`
    ).run()
    expect(
      db.prepare("SELECT reported_cost_usd, reasoning_tokens FROM ai_usage WHERE id = 'u2'").get()
    ).toEqual({ reported_cost_usd: 0.0101, reasoning_tokens: 250 })
  })
})

/**
 * Story memory v2 (F-16.4, F-16.5, F-16.8, F-16.9; plan P1 §0): migrations 0029–0033 are additive only. A
 * database as the build before them left it, holding a row in every table, comes out with every
 * one of those tables, their rows and every schema object byte for byte as they were; only new
 * objects are added, and they start empty (decision P1-D1: nothing is copied in a migration).
 */
/** Every schema object's definition, by type and name. */
const schemaOf = (db: Database.Database): { type: string; name: string; sql: string | null }[] =>
  db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as {
    type: string
    name: string
    sql: string | null
  }[]

/** Every table's rows, in rowid order (virtual tables and their shadow tables included). */
const dumpOf = (db: Database.Database, names: readonly string[]): Record<string, unknown[]> =>
  Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]))

const tableNamesOf = (db: Database.Database): string[] =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((row) => row.name)

/** A value for a column nobody constrained: text, a number, or a real. */
const valueFor = (type: string, column: string): string | number => {
  if (/INT/i.test(type)) return 1
  if (/REAL/i.test(type)) return 0.5
  return `${column}-1`
}

/**
 * One row in every table of `db`, foreign keys off so each can be filled on its own. The node
 * table carries a check (a root has a section type), so its row is written by hand; virtual
 * tables' shadow tables are left to their virtual table.
 */
function fillEveryTable(db: Database.Database): void {
  db.pragma('foreign_keys = OFF')
  db.prepare(
    `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
     VALUES ('ms', NULL, 'manuscript', 'folder', 'Manuscript', 0, NULL, '2026-01-01', '2026-01-01')`
  ).run()
  const virtual = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'").all() as {
        name: string
      }[]
    ).map((row) => row.name)
  )
  const shadow = (name: string): boolean =>
    [...virtual].some((table) => name.startsWith(`${table}_`))
  for (const table of tableNamesOf(db)) {
    if (table === 'node' || table === 'schema_migrations' || shadow(table)) continue
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string
      type: string
    }[]
    const names = columns.map((column) => `"${column.name}"`).join(', ')
    const marks = columns.map(() => '?').join(', ')
    db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${marks})`).run(
      ...columns.map((column) => valueFor(column.type, column.name))
    )
  }
  db.pragma('foreign_keys = ON')
}

describe('story memory tables (0029–0033) leave every older table untouched', () => {
  let db: Database.Database
  const BEFORE = 29

  const schema = (): { type: string; name: string; sql: string | null }[] => schemaOf(db)
  const dump = (names: readonly string[]): Record<string, unknown[]> => dumpOf(db, names)
  const tableNames = (): string[] => tableNamesOf(db)

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, loadMigrations().slice(0, BEFORE))
    fillEveryTable(db)
  })
  afterEach(() => db.close())

  it('keeps sqlite_master and every pre-0029 table byte-identical, and adds only empty tables', () => {
    const tablesBefore = tableNames()
    for (const table of tablesBefore) {
      if (table !== 'schema_migrations') {
        expect(
          (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
          table
        ).toBeGreaterThan(0)
      }
    }
    const objectsBefore = schema()
    const rowsBefore = dump(tablesBefore.filter((table) => table !== 'schema_migrations'))

    const result = migrate(db, loadMigrations().slice(0, 34))
    expect(result.applied).toEqual([
      '0029_story_records',
      '0030_name_index',
      '0031_memory_passage_fts',
      '0032_research_doc',
      '0033_research_filed'
    ])

    const objectsAfter = schema()
    const kept = objectsAfter.filter((object) =>
      objectsBefore.some((before) => before.type === object.type && before.name === object.name)
    )
    expect(JSON.stringify(kept)).toBe(JSON.stringify(objectsBefore))
    expect(JSON.stringify(dump(Object.keys(rowsBefore)))).toBe(JSON.stringify(rowsBefore))

    // FTS5 keeps its own bookkeeping in shadow tables (`memory_passage_fts_config`, …).
    const added = tableNames().filter(
      (table) => !tablesBefore.includes(table) && !table.startsWith('memory_passage_fts_')
    )
    expect(added.sort()).toEqual([
      'alias',
      'author_todo',
      'dismissed',
      'label',
      'label_link',
      'memory_passage_fts',
      'memory_scan',
      'name_mention',
      'record',
      'research_doc',
      'scene_detail'
    ])
    for (const table of added) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBe(0)
    }
  })

  it('0033 adds the two nullable filing columns to research_doc and keeps its rows (F-16.9)', () => {
    migrate(db, loadMigrations().slice(0, 33))
    db.prepare(
      `INSERT INTO research_doc (node_id, origin, context_file_id, file_type, converted, not_canon, created)
       VALUES ('ms', 'upload', NULL, 'md', 0, 0, '2026-10-12')`
    ).run()
    const before = db.prepare('SELECT * FROM research_doc').all()
    expect(migrate(db, loadMigrations().slice(0, 34)).applied).toEqual(['0033_research_filed'])
    const columns = (
      db.prepare('PRAGMA table_info(research_doc)').all() as { name: string; notnull: number }[]
    ).map((column) => [column.name, column.notnull])
    expect(columns.slice(-2)).toEqual([
      ['filed_at', 0],
      ['filed_hash', 0]
    ])
    const after = db.prepare('SELECT * FROM research_doc').all() as Record<string, unknown>[]
    expect(after).toEqual(
      (before as Record<string, unknown>[]).map((row) => ({
        ...row,
        filed_at: null,
        filed_hash: null
      }))
    )
  })

  it('opens at 0031 with a passage table that stems, folds diacritics and filters by its labels', () => {
    migrate(db)
    const insert = db.prepare(
      'INSERT INTO memory_passage_fts (source, owner_id, para, canon, text) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run('scene', 's1', 0, 'canon', 'Mara was running past the café.')
    insert.run('pinned', 'r1', 0, 'notCanon', 'Mara runs a bakery.')
    const hits = (query: string, source?: string): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM memory_passage_fts WHERE memory_passage_fts MATCH ?${
              source === undefined ? '' : ' AND source = ?'
            }`
          )
          .get(...(source === undefined ? [query] : [query, source])) as { n: number }
      ).n
    expect(hits('"runs"')).toBe(2)
    expect(hits('"cafe"')).toBe(1)
    expect(hits('"mara"', 'pinned')).toBe(1)
    // The labels are not searchable words.
    expect(hits('"notCanon"')).toBe(0)
  })
})

describe('story reading tables (0034, F-16.17) leave every older table untouched', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, loadMigrations().slice(0, 34))
    fillEveryTable(db)
  })
  afterEach(() => db.close())

  it('keeps sqlite_master and every pre-0034 table byte-identical, and adds only empty tables', () => {
    const tablesBefore = tableNamesOf(db)
    for (const table of tablesBefore) {
      if (table === 'schema_migrations' || table.startsWith('memory_passage_fts_')) continue
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBeGreaterThan(0)
    }
    const objectsBefore = schemaOf(db)
    const rowsBefore = dumpOf(
      db,
      tablesBefore.filter((table) => table !== 'schema_migrations')
    )

    expect(migrate(db, loadMigrations().slice(0, 35)).applied).toEqual(['0034_story_reading'])

    const kept = schemaOf(db).filter((object) =>
      objectsBefore.some((before) => before.type === object.type && before.name === object.name)
    )
    expect(JSON.stringify(kept)).toBe(JSON.stringify(objectsBefore))
    expect(JSON.stringify(dumpOf(db, Object.keys(rowsBefore)))).toBe(JSON.stringify(rowsBefore))

    const added = tableNamesOf(db).filter((table) => !tablesBefore.includes(table))
    expect(added.sort()).toEqual([
      'card',
      'claim',
      'memory_backfill',
      'plan_link',
      'reading',
      'scene_read'
    ])
    for (const table of added) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBe(0)
    }
    // Only tables and their indexes were added: nothing else in sqlite_master moved.
    const addedObjects = schemaOf(db)
      .filter(
        (object) =>
          !objectsBefore.some(
            (before) => before.type === object.type && before.name === object.name
          )
      )
      .map((object) => `${object.type} ${object.name}`)
    expect(addedObjects.sort()).toEqual([
      'index claim_node_idx',
      'index claim_record_idx',
      'index claim_state_idx',
      'index reading_model_idx',
      'index reading_node_idx',
      'index sqlite_autoindex_card_1',
      'index sqlite_autoindex_claim_1',
      'index sqlite_autoindex_memory_backfill_1',
      'index sqlite_autoindex_plan_link_1',
      'index sqlite_autoindex_reading_1',
      'index sqlite_autoindex_scene_read_1',
      'table card',
      'table claim',
      'table memory_backfill',
      'table plan_link',
      'table reading',
      'table scene_read'
    ])
  })

  it('drops a scene’s evidence with the scene and with its draft, and a claim with its record', () => {
    migrate(db)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('s1', 'ms', NULL, 'document', 'One', 0, NULL, '2026-10-12', '2026-10-12')`
    ).run()
    db.prepare(
      "INSERT INTO draft (id, name, position, created, modified) VALUES ('d2', 'Two', 1, 'x', 'x')"
    ).run()
    db.prepare(
      "INSERT INTO record (id, category_id, origin, created, modified) VALUES ('r2', 'character', 'author', 'x', 'x')"
    ).run()
    const reading = db.prepare(
      `INSERT INTO reading (id, node_id, draft_id, purpose, prompt_version, model, created)
       VALUES (?, 's1', ?, 'first', 'reader.v1', 'm', 'x')`
    )
    reading.run('g1', 'd2')
    const claim = db.prepare(
      `INSERT INTO claim (id, node_id, draft_id, reading_id, record_id, slot, value, value_key, voice,
         mode, quote, para, proof, state, created, proved)
       VALUES (?, 's1', 'd2', 'g1', ?, 'eyes', 'grey', 'grey', 'narration', 'now', 'q', 0, 'literal',
         'live', 'x', 'x')`
    )
    claim.run('c1', 'r2')
    claim.run('c2', null)
    db.prepare(
      "INSERT INTO card (node_id, draft_id, reading_id, line, gist, created) VALUES ('s1', 'd2', 'g1', 'l', 'g', 'x')"
    ).run()
    db.prepare(
      "INSERT INTO scene_read (node_id, draft_id, reading_id, updated) VALUES ('s1', 'd2', 'g1', 'x')"
    ).run()
    const count = (table: string): number =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE node_id = 's1'`).get() as {
          n: number
        }
      ).n

    db.prepare("DELETE FROM record WHERE id = 'r2'").run()
    expect(count('claim')).toBe(1)
    // A reading that goes leaves its rows, the link cleared.
    db.prepare("DELETE FROM reading WHERE id = 'g1'").run()
    expect(
      db.prepare("SELECT reading_id FROM claim WHERE id = 'c2'").get() as {
        reading_id: string | null
      }
    ).toEqual({ reading_id: null })
    reading.run('g2', 'd2')
    db.prepare("DELETE FROM draft WHERE id = 'd2'").run()
    for (const table of ['claim', 'card', 'scene_read', 'reading'])
      expect(count(table), table).toBe(0)
  })

  it('0035 adds a nullable draft_id to plan_link, keeps its rows and drops a link with its draft (F-16.21)', () => {
    migrate(db, loadMigrations().slice(0, 35))
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES (?, 'ms', NULL, 'document', ?, 0, NULL, '2026-10-12', '2026-10-12')`
    ).run('plan', 'Plan')
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES (?, 'ms', NULL, 'document', ?, 1, NULL, '2026-10-12', '2026-10-12')`
    ).run('done', 'Done')
    db.prepare(
      "INSERT INTO plan_link (plan_id, scene_id, origin, created) VALUES ('plan', 'done', 'code', 'x')"
    ).run()
    const before = db.prepare('SELECT * FROM plan_link').all() as Record<string, unknown>[]
    expect(migrate(db, loadMigrations().slice(0, 36)).applied).toEqual(['0035_plan_link_draft'])
    const columns = (
      db.prepare('PRAGMA table_info(plan_link)').all() as { name: string; notnull: number }[]
    ).map((column) => [column.name, column.notnull])
    expect(columns.at(-1)).toEqual(['draft_id', 0])
    expect(db.prepare('SELECT * FROM plan_link').all()).toEqual(
      before.map((row) => ({ ...row, draft_id: null }))
    )
    db.prepare(
      "INSERT INTO draft (id, name, position, created, modified) VALUES ('d3', 'Three', 2, 'x', 'x')"
    ).run()
    db.prepare("UPDATE plan_link SET draft_id = 'd3' WHERE plan_id = 'plan'").run()
    db.prepare("DELETE FROM draft WHERE id = 'd3'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_link').get()).toEqual({ n: 0 })
  })
})

describe('who knows what (0036, F-16.22, F-16.23) leaves every older row and column', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, loadMigrations().slice(0, 36))
    fillEveryTable(db)
  })
  afterEach(() => db.close())

  const columnsOf = (table: string): { name: string; notnull: number; dflt_value: unknown }[] =>
    db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string
      notnull: number
      dflt_value: unknown
    }[]

  it('keeps every older table and value, adds two empty tables and three defaulted columns', () => {
    const tablesBefore = tableNamesOf(db)
    for (const table of tablesBefore) {
      if (table === 'schema_migrations' || table.startsWith('memory_passage_fts_')) continue
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBeGreaterThan(0)
    }
    const objectsBefore = schemaOf(db)
    const rowsBefore = dumpOf(
      db,
      tablesBefore.filter((table) => table !== 'schema_migrations')
    )
    const claimColumns = columnsOf('claim').map((column) => column.name)
    const readColumns = columnsOf('scene_read').map((column) => column.name)

    expect(migrate(db, loadMigrations().slice(0, 37)).applied).toEqual(['0036_story_knows'])

    // Every table but the two that gained a column is byte-identical, definition and rows.
    const widened = new Set(['claim', 'scene_read'])
    const kept = schemaOf(db).filter(
      (object) =>
        !widened.has(object.name) &&
        objectsBefore.some((before) => before.type === object.type && before.name === object.name)
    )
    expect(JSON.stringify(kept)).toBe(
      JSON.stringify(objectsBefore.filter((object) => !widened.has(object.name)))
    )
    const unchanged = Object.keys(rowsBefore).filter((table) => !widened.has(table))
    expect(JSON.stringify(dumpOf(db, unchanged))).toBe(
      JSON.stringify(Object.fromEntries(unchanged.map((table) => [table, rowsBefore[table]])))
    )
    // The two widened tables keep every old column and value and gain the new ones.
    expect(columnsOf('claim').map((column) => column.name)).toEqual([
      ...claimColumns,
      'topic_quote_id'
    ])
    expect(columnsOf('scene_read').map((column) => column.name)).toEqual([
      ...readColumns,
      'topics_read',
      'settled'
    ])
    expect(db.prepare('SELECT * FROM claim').all()).toEqual(
      (rowsBefore.claim ?? []).map((row) => ({ ...(row as object), topic_quote_id: null }))
    )
    expect(db.prepare('SELECT * FROM scene_read').all()).toEqual(
      (rowsBefore.scene_read ?? []).map((row) => ({
        ...(row as object),
        topics_read: 0,
        settled: 0
      }))
    )
    for (const name of ['topics_read', 'settled']) {
      expect(columnsOf('scene_read').find((column) => column.name === name)?.notnull).toBe(1)
    }

    const added = tableNamesOf(db).filter((table) => !tablesBefore.includes(table))
    expect(added.sort()).toEqual(['knew_before', 'topic_quote'])
    for (const table of added) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBe(0)
    }
    const addedObjects = schemaOf(db)
      .filter(
        (object) =>
          !objectsBefore.some(
            (before) => before.type === object.type && before.name === object.name
          )
      )
      .map((object) => `${object.type} ${object.name}`)
    expect(addedObjects.sort()).toEqual([
      'index sqlite_autoindex_knew_before_1',
      'index sqlite_autoindex_topic_quote_1',
      'index topic_quote_node_idx',
      'index topic_quote_record_idx',
      'table knew_before',
      'table topic_quote'
    ])
  })

  it('cascades topic quotes and knew-before with their records, scene and draft; a claim keeps its row', () => {
    migrate(db)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('s1', 'ms', NULL, 'document', 'One', 0, NULL, '2026-10-12', '2026-10-12')`
    ).run()
    db.prepare(
      "INSERT INTO draft (id, name, position, created, modified) VALUES ('d2', 'Two', 1, 'x', 'x')"
    ).run()
    const record = db.prepare(
      "INSERT INTO record (id, category_id, origin, created, modified) VALUES (?, ?, 'ai', 'x', 'x')"
    )
    record.run('secret1', 'secret')
    record.run('mara', 'character')
    record.run('tomas', 'character')
    const quote = db.prepare(
      `INSERT INTO topic_quote (id, record_id, draft_id, node_id, role, label, para, quote, state,
         created, proved)
       VALUES (?, ?, 'd2', 's1', ?, 'the sold map', 0, 'Tomas sold the map.', 'live', 'x', 'x')`
    )
    quote.run('q1', 'secret1', 'defining')
    quote.run('q2', 'secret1', 'merged')
    db.prepare(
      `INSERT INTO claim (id, node_id, draft_id, record_id, slot, value, value_key, object_id, how,
         voice, mode, quote, para, proof, state, created, proved, topic_quote_id)
       VALUES ('c1', 's1', 'd2', 'mara', 'knows', 'overheard', 'overheard', 'secret1', 'overheard',
         'narration', 'now', 'q', 0, 'verified', 'live', 'x', 'x', 'q2')`
    ).run()
    const knew = db.prepare(
      "INSERT INTO knew_before (secret_id, record_id, created) VALUES ('secret1', ?, 'x')"
    )
    knew.run('mara')
    knew.run('tomas')
    const n = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n

    // A merged reveal that goes leaves its claims, untagged.
    db.prepare("DELETE FROM topic_quote WHERE id = 'q2'").run()
    expect(db.prepare("SELECT topic_quote_id FROM claim WHERE id = 'c1'").get()).toEqual({
      topic_quote_id: null
    })
    // A knower that goes takes its knew-before row.
    db.prepare("DELETE FROM record WHERE id = 'tomas'").run()
    expect(n('knew_before')).toBe(1)
    // The secret that goes takes its reveals and knew-before rows; the knows claim's object clears.
    db.prepare("DELETE FROM record WHERE id = 'secret1'").run()
    expect(n('topic_quote')).toBe(0)
    expect(n('knew_before')).toBe(0)
    expect(db.prepare("SELECT object_id FROM claim WHERE id = 'c1'").get()).toEqual({
      object_id: null
    })
    // A scene's and a draft's reveals go with them.
    record.run('thread1', 'thread')
    quote.run('q3', 'thread1', 'defining')
    quote.run('q4', 'thread1', 'merged')
    db.prepare(
      "UPDATE topic_quote SET draft_id = (SELECT id FROM draft WHERE id <> 'd2' LIMIT 1) WHERE id = 'q4'"
    ).run()
    db.prepare("DELETE FROM draft WHERE id = 'd2'").run()
    expect(n('topic_quote')).toBe(1)
    db.prepare("DELETE FROM node WHERE id = 's1'").run()
    expect(n('topic_quote')).toBe(0)
  })
})

describe('search misses (0037, F-16.25) leave every older row and column', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, loadMigrations().slice(0, 37))
    fillEveryTable(db)
  })
  afterEach(() => db.close())

  it('keeps every older table and value byte for byte and adds one empty table', () => {
    const tablesBefore = tableNamesOf(db)
    for (const table of tablesBefore) {
      if (table === 'schema_migrations' || table.startsWith('memory_passage_fts_')) continue
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBeGreaterThan(0)
    }
    const objectsBefore = schemaOf(db)
    const kept = tablesBefore.filter((table) => table !== 'schema_migrations')
    const rowsBefore = dumpOf(db, kept)

    expect(migrate(db, loadMigrations().slice(0, 38)).applied).toEqual(['0037_search_miss'])

    const old = schemaOf(db).filter((object) =>
      objectsBefore.some((before) => before.type === object.type && before.name === object.name)
    )
    expect(JSON.stringify(old)).toBe(JSON.stringify(objectsBefore))
    expect(JSON.stringify(dumpOf(db, kept))).toBe(JSON.stringify(rowsBefore))
    expect(tableNamesOf(db).filter((table) => !tablesBefore.includes(table))).toEqual([
      'search_miss'
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_miss').get()).toEqual({ n: 0 })
    const added = schemaOf(db)
      .filter(
        (object) =>
          !objectsBefore.some(
            (before) => before.type === object.type && before.name === object.name
          )
      )
      .map((object) => `${object.type} ${object.name}`)
    expect(added.sort()).toEqual([
      'index search_miss_created_idx',
      'index sqlite_autoindex_search_miss_1',
      'table search_miss'
    ])
  })

  it('drops a miss with its scene', () => {
    migrate(db)
    db.pragma('foreign_keys = ON')
    db.prepare(
      `INSERT INTO node (id, parent_id, section_type, kind, title, position, content, created, modified)
       VALUES ('s9', 'ms', NULL, 'document', 'Nine', 0, NULL, '2026-10-13', '2026-10-13')`
    ).run()
    db.prepare(
      `INSERT INTO search_miss (id, created, question, node_id, para, quote, prompt_version)
       VALUES ('m1', '2026-10-13', 'When does Orrin first hear?', 's9', 2, 'Orrin heard', 'agent.v9')`
    ).run()
    expect(db.prepare("SELECT terms FROM search_miss WHERE id = 'm1'").get()).toEqual({
      terms: '[]'
    })
    db.prepare("DELETE FROM node WHERE id = 's9'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_miss').get()).toEqual({ n: 0 })
  })
})

describe('contradictions (0038, F-16.27) leave every older row and column', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, loadMigrations().slice(0, 38))
    fillEveryTable(db)
  })
  afterEach(() => db.close())

  it('keeps every older table and value byte for byte and adds two empty tables', () => {
    const tablesBefore = tableNamesOf(db)
    for (const table of tablesBefore) {
      if (table === 'schema_migrations' || table.startsWith('memory_passage_fts_')) continue
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBeGreaterThan(0)
    }
    const objectsBefore = schemaOf(db)
    const kept = tablesBefore.filter((table) => table !== 'schema_migrations')
    const rowsBefore = dumpOf(db, kept)

    expect(migrate(db, loadMigrations().slice(0, 39)).applied).toEqual(['0038_story_findings'])

    const old = schemaOf(db).filter((object) =>
      objectsBefore.some((before) => before.type === object.type && before.name === object.name)
    )
    expect(JSON.stringify(old)).toBe(JSON.stringify(objectsBefore))
    expect(JSON.stringify(dumpOf(db, kept))).toBe(JSON.stringify(rowsBefore))
    const added = tableNamesOf(db).filter((table) => !tablesBefore.includes(table))
    expect(added.sort()).toEqual(['finding', 'verdict_cache'])
    for (const table of added) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        table
      ).toBe(0)
    }
    const addedObjects = schemaOf(db)
      .filter(
        (object) =>
          !objectsBefore.some(
            (before) => before.type === object.type && before.name === object.name
          )
      )
      .map((object) => `${object.type} ${object.name}`)
    expect(addedObjects.sort()).toEqual([
      'index finding_draft_key_uq',
      'index finding_draft_state_idx',
      'index finding_record_idx',
      'index sqlite_autoindex_finding_1',
      'index sqlite_autoindex_verdict_cache_1',
      'index verdict_cache_used_idx',
      'table finding',
      'table verdict_cache'
    ])
  })

  it('drops a finding with its record and with its draft, one per draft and key', () => {
    migrate(db)
    db.pragma('foreign_keys = ON')
    db.prepare(
      "INSERT INTO draft (id, name, position, created, modified) VALUES ('d2', 'Two', 1, 'x', 'x')"
    ).run()
    const record = db.prepare(
      "INSERT INTO record (id, category_id, origin, created, modified) VALUES (?, 'character', 'author', 'x', 'x')"
    )
    record.run('mara')
    record.run('tomas')
    const insert = db.prepare(
      `INSERT INTO finding (id, draft_id, rule, record_id, slot, key, np_key, a, b, state, created)
       VALUES (?, 'd2', 'C1', ?, 'eyes', ?, ?, '{}', '{}', 'unjudged', 'x')`
    )
    insert.run('f1', 'mara', 'C1|k1', 'k1')
    insert.run('f2', 'tomas', 'C1|k2', 'k2')
    expect(() => insert.run('f3', 'mara', 'C1|k1', 'k1')).toThrow()
    expect(db.prepare("SELECT cost_usd, verdict_ab FROM finding WHERE id = 'f1'").get()).toEqual({
      cost_usd: 0,
      verdict_ab: null
    })
    const n = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM finding').get() as { n: number }).n
    db.prepare("DELETE FROM record WHERE id = 'mara'").run()
    expect(n()).toBe(1)
    db.prepare("DELETE FROM draft WHERE id = 'd2'").run()
    expect(n()).toBe(0)
    db.prepare(
      `INSERT INTO verdict_cache (key, verdict, tier, prompt_version, model, created, used)
       VALUES ('h1', 'c', 'fast', 'judge.v1', 'm', 'x', 'x')`
    ).run()
    expect(db.prepare("SELECT cost_usd FROM verdict_cache WHERE key = 'h1'").get()).toEqual({
      cost_usd: 0
    })
  })
})
