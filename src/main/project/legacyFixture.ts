import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A v0 project database for the F-1.6 tests, made with v0's own `CREATE TABLE` statements (from
 * the prototype's `database.ts`, kept here because the prototype is gone). Test-only.
 */

const V0_SCHEMA = `
CREATE TABLE project (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  novel_format TEXT NOT NULL DEFAULT 'novel' CHECK(novel_format IN ('novel', 'epic', 'webnovel')),
  created TEXT NOT NULL, modified TEXT NOT NULL, last_opened TEXT NOT NULL,
  focus_bg_rotation INTEGER DEFAULT 0, focus_bg_rotation_interval INTEGER DEFAULT 10,
  focus_bg_current TEXT, focus_overlay_opacity INTEGER DEFAULT 50,
  focus_window_width INTEGER DEFAULT 50, focus_window_offset_x INTEGER DEFAULT 0
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('document', 'folder')), content TEXT,
  doc_type TEXT CHECK(doc_type IN ('manuscript', 'note', NULL)),
  hierarchy_level TEXT CHECK(hierarchy_level IN ('novel', 'part', 'chapter', 'scene', NULL)),
  notes TEXT, word_count INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  location TEXT, pov TEXT, timeline_position TEXT, scene_metadata TEXT,
  section TEXT CHECK(section IN ('front-matter', 'manuscript', 'end-matter', NULL)),
  matter_type TEXT, formatting_preset TEXT, created TEXT NOT NULL, modified TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE TABLE reference_docs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('character', 'setting', 'worldBuilding')),
  content TEXT NOT NULL, created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  category TEXT CHECK(category IN ('character', 'setting', 'worldBuilding', 'tone', 'content', 'plot-thread', 'custom')),
  parent_tag_id TEXT, color TEXT NOT NULL DEFAULT '#999999', usage_count INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL, modified TEXT NOT NULL
);
CREATE TABLE document_tags (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  position_start INTEGER, position_end INTEGER, created TEXT NOT NULL
);
CREATE TABLE scene_summaries (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, summary TEXT NOT NULL, key_points TEXT,
  characters_present TEXT, created TEXT NOT NULL, modified TEXT NOT NULL
);
`

const T = '2025-11-01T10:00:00.000Z'

/** Slate JSON as v0 stored it. */
export const slate = (...paragraphs: string[]): string =>
  JSON.stringify(paragraphs.map((text) => ({ type: 'paragraph', children: [{ text }] })))

export const V0_SCENE_TEXT = 'Mara waited at the ferry landing until the bell rang.'

/** Writes a small v0 project to `file`: a part, a chapter, two scenes, matter, a note, tags, references. */
export function writeV0Project(file: string, name = 'Ferryman'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    db.exec(V0_SCHEMA)
    db.prepare(
      'INSERT INTO project (id, name, novel_format, created, modified, last_opened) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('p1', name, 'epic', T, T, T)
    const doc = db.prepare(
      `INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes,
        position, location, pov, timeline_position, section, matter_type, created, modified)
       VALUES (@id, @parent_id, @name, @type, @content, @doc_type, @hierarchy_level, @notes,
        @position, @location, @pov, @timeline_position, @section, @matter_type, @created, @modified)`
    )
    const base = {
      content: null,
      doc_type: null,
      hierarchy_level: null,
      notes: null,
      location: null,
      pov: null,
      timeline_position: null,
      section: null,
      matter_type: null,
      created: T,
      modified: T
    }
    doc.run({
      ...base,
      id: 'part',
      parent_id: null,
      name: 'Part One',
      type: 'folder',
      position: 0,
      section: 'manuscript',
      hierarchy_level: 'part'
    })
    doc.run({
      ...base,
      id: 'ch1',
      parent_id: 'part',
      name: 'The River',
      type: 'folder',
      position: 0,
      hierarchy_level: 'chapter'
    })
    doc.run({
      ...base,
      id: 's2',
      parent_id: 'ch1',
      name: 'Crossing',
      type: 'document',
      position: 1,
      hierarchy_level: 'scene',
      content: slate('The boat tipped twice.')
    })
    doc.run({
      ...base,
      id: 's1',
      parent_id: 'ch1',
      name: 'Landing',
      type: 'document',
      position: 0,
      hierarchy_level: 'scene',
      doc_type: 'manuscript',
      content: JSON.stringify([
        { type: 'heading', level: 2, children: [{ text: 'Dawn' }] },
        {
          type: 'paragraph',
          align: 'center',
          children: [
            { text: 'Mara waited at the ' },
            { text: 'ferry landing', bold: true, isTag: true, tagId: 't-ferry', tagName: 'ferry' },
            { text: ' until the bell rang.' }
          ]
        },
        { type: 'sceneBreak', children: [{ text: '' }] },
        { type: 'blockquote', children: [{ text: 'Cross by noon.', italic: true }] }
      ]),
      notes: slate('Remember the bell.'),
      location: 'The landing',
      pov: 'Mara',
      timeline_position: 'Day 1'
    })
    doc.run({
      ...base,
      id: 'title',
      parent_id: null,
      name: 'Title Page',
      type: 'document',
      position: 0,
      section: 'front-matter',
      matter_type: 'title-page',
      content: slate('FERRYMAN')
    })
    doc.run({
      ...base,
      id: 'note1',
      parent_id: null,
      name: 'Research',
      type: 'document',
      position: 5,
      doc_type: 'note',
      content: slate('Ferries ran until 1900.')
    })
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('editor_text_size', '18')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'editor_scene_break_style',
      '~~~'
    )
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('editor_max_width', '5000')
    const tag = db.prepare(
      'INSERT INTO tags (id, name, category, parent_tag_id, color, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    tag.run('t-mara', 'Mara', 'character', null, '#AA0000', T, T)
    tag.run('t-young', 'Young Mara', 'character', 't-mara', 'red', T, T)
    tag.run('t-thread', 'the debt', 'plot-thread', null, '#00aa00', T, T)
    const link = db.prepare(
      'INSERT INTO document_tags (id, document_id, tag_id, created) VALUES (?, ?, ?, ?)'
    )
    link.run('l1', 's1', 't-mara', T)
    link.run('l2', 'ch1', 't-thread', T)
    link.run('l3', 'gone', 't-mara', T)
    const ref = db.prepare(
      'INSERT INTO reference_docs (id, name, category, content, created, modified) VALUES (?, ?, ?, ?, ?, ?)'
    )
    ref.run('r1', 'Mara', 'character', 'Grey eyes.\nAfraid of deep water.', T, T)
    ref.run('r2', 'The Landing', 'setting', 'A rotten jetty.', T, T)
    ref.run('r3', 'Mara', 'character', 'A duplicate.', T, T)
    db.prepare(
      'INSERT INTO scene_summaries (id, document_id, summary, created, modified) VALUES (?, ?, ?, ?, ?)'
    ).run('sum1', 's1', 'Mara waits.', T, T)
  } finally {
    db.close()
  }
}
