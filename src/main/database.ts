// src/main/database.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface ProjectMetadata {
  id: string;
  name: string;
  created: string;
  modified: string;
  last_opened: string;
}

export interface DocumentRow {
  id: string;
  parent_id: string | null;
  name: string;
  type: 'document' | 'folder';
  content: string | null; // Slate JSON stringified
  doc_type: 'manuscript' | 'note' | null;
  hierarchy_level: 'novel' | 'part' | 'chapter' | 'scene' | null; // Novel structure
  notes: string | null; // Slate JSON for scene/chapter notes
  word_count: number; // Cached word count
  position: number; // for ordering
  created: string;
  modified: string;
}

export interface ReferenceRow {
  id: string;
  name: string;
  category: 'character' | 'setting' | 'worldBuilding';
  content: string;
  created: string;
  modified: string;
}

export interface TagRow {
  id: string;
  name: string;
  category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null;
  parent_tag_id: string | null;
  color: string;
  usage_count: number;
  created: string;
  modified: string;
}

export class ProjectDatabase {
  private db: Database.Database;

  constructor(projectPath: string) {
    // Ensure directory exists
    const dir = path.dirname(projectPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(projectPath);
    this.initializeTables();
  }

  private runMigrations() {
    // Check if documents table exists
    const tableInfo = this.db.pragma('table_info(documents)') as Array<{ name: string }>;

    if (tableInfo.length === 0) {
      // Table doesn't exist yet, skip migrations
      return;
    }

    // Check and add hierarchy_level column
    const hasHierarchyLevel = tableInfo.some((col) => col.name === 'hierarchy_level');
    if (!hasHierarchyLevel) {
      console.log('Running migration: Adding hierarchy_level column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN hierarchy_level TEXT CHECK(hierarchy_level IN ('novel', 'part', 'chapter', 'scene', NULL))
        `);
        console.log('Migration completed: hierarchy_level column added');
      } catch (error) {
        console.error('Migration error (hierarchy_level):', error);
      }
    }

    // Check and add notes column
    const hasNotes = tableInfo.some((col) => col.name === 'notes');
    if (!hasNotes) {
      console.log('Running migration: Adding notes column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN notes TEXT
        `);
        console.log('Migration completed: notes column added');
      } catch (error) {
        console.error('Migration error (notes):', error);
      }
    }

    // Check and add word_count column
    const hasWordCount = tableInfo.some((col) => col.name === 'word_count');
    if (!hasWordCount) {
      console.log('Running migration: Adding word_count column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0
        `);
        console.log('Migration completed: word_count column added');
      } catch (error) {
        console.error('Migration error (word_count):', error);
      }
    }

    // Check and add doc_type column
    const hasDocType = tableInfo.some((col) => col.name === 'doc_type');
    if (!hasDocType) {
      console.log('Running migration: Adding doc_type column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN doc_type TEXT CHECK(doc_type IN ('manuscript', 'note', NULL))
        `);
        console.log('Migration completed: doc_type column added');
      } catch (error) {
        console.error('Migration error (doc_type):', error);
      }
    }
  }

  private initializeTables() {
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Run migrations first
    this.runMigrations();

    // Project metadata
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        last_opened TEXT NOT NULL
      )
    `);

    // Documents and folders (hierarchical structure)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('document', 'folder')),
        content TEXT,
        doc_type TEXT CHECK(doc_type IN ('manuscript', 'note', NULL)),
        hierarchy_level TEXT CHECK(hierarchy_level IN ('novel', 'part', 'chapter', 'scene', NULL)),
        notes TEXT,
        word_count INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);

    // Index for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_parent 
      ON documents(parent_id)
    `);

    // References (characters, settings, world-building)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reference_docs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('character', 'setting', 'worldBuilding')),
        content TEXT NOT NULL,
        created TEXT NOT NULL,
        modified TEXT NOT NULL
      )
    `);

    // Settings/preferences
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Tags (for Story Intelligence system)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT CHECK(category IN ('character', 'setting', 'worldBuilding', 'tone', 'content', 'plot-thread', 'custom')),
        parent_tag_id TEXT,
        color TEXT NOT NULL DEFAULT '#999999',
        usage_count INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        FOREIGN KEY (parent_tag_id) REFERENCES tags(id) ON DELETE SET NULL
      )
    `);

    // Create index for faster tag queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tag_category
      ON tags(category)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tag_name
      ON tags(name)
    `);

    // Document-Tag relationship (many-to-many)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_tags (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        position_start INTEGER,
        position_end INTEGER,
        created TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for faster tag lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_document_tags_doc
      ON document_tags(document_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_document_tags_tag
      ON document_tags(tag_id)
    `);

    // Tag Templates (pre-built tag structures)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tag_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        is_global INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL
      )
    `);

    // Scene Summaries (AI-generated cache for fast lookups)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scene_summaries (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_points TEXT,
        characters_present TEXT,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);

    // Create index for faster summary lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scene_summary_doc
      ON scene_summaries(document_id)
    `);
  }

  // ============= PROJECT OPERATIONS =============

  createProject(name: string): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO project (id, name, created, modified, last_opened)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, now, now, now);

    // Create root folder
    this.createFolder('Manuscript', null);

    // Seed default tag templates
    this.seedDefaultTagTemplates();

    return id;
  }

  getProjectMetadata(): ProjectMetadata | undefined {
    return this.db.prepare('SELECT * FROM project LIMIT 1').get() as ProjectMetadata | undefined;
  }

  updateProjectModified() {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE project SET modified = ?').run(now);
  }

  updateLastOpened() {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE project SET last_opened = ?').run(now);
  }

  // ============= DOCUMENT OPERATIONS =============

  createDocument(
    name: string,
    parentId: string | null,
    docType: 'manuscript' | 'note' = 'manuscript',
    hierarchyLevel: 'novel' | 'part' | 'chapter' | 'scene' | null = null
  ): string {
    const id = this.generateId();
    const now = new Date().toISOString();
    const position = this.getNextPosition(parentId);

    // Initial empty Slate content
    const initialContent = JSON.stringify([
      { type: 'paragraph', children: [{ text: '' }] }
    ]);

    const initialNotes = JSON.stringify([
      { type: 'paragraph', children: [{ text: '' }] }
    ]);

    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, created, modified)
      VALUES (?, ?, ?, 'document', ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, parentId, name, initialContent, docType, hierarchyLevel, initialNotes, position, now, now);

    this.updateProjectModified();
    return id;
  }

  createFolder(
    name: string,
    parentId: string | null,
    hierarchyLevel: 'novel' | 'part' | 'chapter' | null = null
  ): string {
    const id = this.generateId();
    const now = new Date().toISOString();
    const position = this.getNextPosition(parentId);

    const initialNotes = JSON.stringify([
      { type: 'paragraph', children: [{ text: '' }] }
    ]);

    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, created, modified)
      VALUES (?, ?, ?, 'folder', NULL, NULL, ?, ?, 0, ?, ?, ?)
    `).run(id, parentId, name, hierarchyLevel, initialNotes, position, now, now);

    this.updateProjectModified();
    return id;
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  }

  getDocumentsByParent(parentId: string | null): DocumentRow[] {
    return this.db.prepare(
      'SELECT * FROM documents WHERE parent_id IS ? ORDER BY position ASC'
    ).all(parentId) as DocumentRow[];
  }

  getAllDocuments(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents ORDER BY position ASC').all() as DocumentRow[];
  }

  updateDocumentContent(id: string, content: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE documents 
      SET content = ?, modified = ?
      WHERE id = ?
    `).run(content, now, id);

    this.updateProjectModified();
  }

  updateDocumentName(id: string, name: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE documents
      SET name = ?, modified = ?
      WHERE id = ?
    `).run(name, now, id);

    this.updateProjectModified();
  }

  updateDocumentNotes(id: string, notes: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE documents
      SET notes = ?, modified = ?
      WHERE id = ?
    `).run(notes, now, id);

    this.updateProjectModified();
  }

  updateDocumentWordCount(id: string, wordCount: number) {
    this.db.prepare(`
      UPDATE documents
      SET word_count = ?
      WHERE id = ?
    `).run(wordCount, id);
  }

  deleteDocument(id: string) {
    // Foreign key cascade will delete children
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    this.updateProjectModified();
  }

  moveDocument(id: string, newParentId: string | null, newPosition: number) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE documents 
      SET parent_id = ?, position = ?, modified = ?
      WHERE id = ?
    `).run(newParentId, newPosition, now, id);

    this.updateProjectModified();
  }

  // ============= REFERENCE OPERATIONS =============

  createReference(name: string, category: 'character' | 'setting' | 'worldBuilding', content: string = ''): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO reference_docs (id, name, category, content, created, modified)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, category, content, now, now);

    this.updateProjectModified();
    return id;
  }

  getReference(id: string): ReferenceRow | undefined {
    return this.db.prepare('SELECT * FROM reference_docs WHERE id = ?').get(id) as ReferenceRow | undefined;
  }

  getReferencesByCategory(category: 'character' | 'setting' | 'worldBuilding'): ReferenceRow[] {
    return this.db.prepare(
      'SELECT * FROM reference_docs WHERE category = ? ORDER BY name ASC'
    ).all(category) as ReferenceRow[];
  }

  getAllReferences(): ReferenceRow[] {
    return this.db.prepare('SELECT * FROM reference_docs ORDER BY category, name ASC').all() as ReferenceRow[];
  }

  updateReference(id: string, content: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE reference_docs 
      SET content = ?, modified = ?
      WHERE id = ?
    `).run(content, now, id);

    this.updateProjectModified();
  }

  updateReferenceName(id: string, name: string) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE reference_docs 
      SET name = ?, modified = ?
      WHERE id = ?
    `).run(name, now, id);

    this.updateProjectModified();
  }

  deleteReference(id: string) {
    this.db.prepare('DELETE FROM reference_docs WHERE id = ?').run(id);
    this.updateProjectModified();
  }

  // ============= SETTINGS OPERATIONS =============

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // ============= TAG OPERATIONS =============

  createTag(
    name: string,
    category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null,
    color: string = '#999999',
    parentTagId: string | null = null
  ): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tags (id, name, category, parent_tag_id, color, usage_count, created, modified)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, name, category, parentTagId, color, now, now);

    this.updateProjectModified();
    return id;
  }

  getTag(id: string): TagRow | undefined {
    return this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
  }

  getAllTags(): TagRow[] {
    return this.db.prepare('SELECT * FROM tags ORDER BY category, name ASC').all() as TagRow[];
  }

  getTagsByCategory(category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom'): TagRow[] {
    return this.db.prepare(
      'SELECT * FROM tags WHERE category = ? ORDER BY name ASC'
    ).all(category) as TagRow[];
  }

  updateTag(id: string, name: string, color: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tags
      SET name = ?, color = ?, category = ?, modified = ?
      WHERE id = ?
    `).run(name, color, category, now, id);

    this.updateProjectModified();
  }

  deleteTag(id: string) {
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    this.updateProjectModified();
  }

  incrementTagUsage(id: string) {
    this.db.prepare(`
      UPDATE tags
      SET usage_count = usage_count + 1
      WHERE id = ?
    `).run(id);
  }

  // ============= DOCUMENT-TAG RELATIONSHIP OPERATIONS =============

  addTagToDocument(documentId: string, tagId: string, positionStart?: number | null, positionEnd?: number | null): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO document_tags (id, document_id, tag_id, position_start, position_end, created)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, documentId, tagId, positionStart || null, positionEnd || null, now);

    // Increment tag usage count
    this.incrementTagUsage(tagId);
    this.updateProjectModified();
    return id;
  }

  removeTagFromDocument(documentId: string, tagId: string) {
    this.db.prepare(`
      DELETE FROM document_tags
      WHERE document_id = ? AND tag_id = ?
    `).run(documentId, tagId);

    // Decrement tag usage count
    this.db.prepare(`
      UPDATE tags
      SET usage_count = CASE WHEN usage_count > 0 THEN usage_count - 1 ELSE 0 END
      WHERE id = ?
    `).run(tagId);

    this.updateProjectModified();
  }

  getDocumentTags(documentId: string): TagRow[] {
    return this.db.prepare(`
      SELECT t.* FROM tags t
      INNER JOIN document_tags dt ON dt.tag_id = t.id
      WHERE dt.document_id = ?
      ORDER BY t.category, t.name ASC
    `).all(documentId) as TagRow[];
  }

  getDocumentsByTag(tagId: string): DocumentRow[] {
    return this.db.prepare(`
      SELECT d.* FROM documents d
      INNER JOIN document_tags dt ON dt.document_id = d.id
      WHERE dt.tag_id = ?
      ORDER BY d.modified DESC
    `).all(tagId) as DocumentRow[];
  }

  // ============= TAG TEMPLATE OPERATIONS =============

  createTagTemplate(name: string, tagsJson: string, isGlobal: boolean = true): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tag_templates (id, name, tags_json, is_global, created)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, tagsJson, isGlobal ? 1 : 0, now);

    return id;
  }

  getAllTagTemplates(): Array<{ id: string; name: string; tags_json: string; is_global: number; created: string }> {
    return this.db.prepare('SELECT * FROM tag_templates ORDER BY name ASC').all() as Array<{ id: string; name: string; tags_json: string; is_global: number; created: string }>;
  }

  deleteTagTemplate(id: string) {
    this.db.prepare('DELETE FROM tag_templates WHERE id = ?').run(id);
  }

  seedDefaultTagTemplates() {
    // Check if templates already exist
    const existing = this.getAllTagTemplates();
    if (existing.length > 0) {
      return; // Already seeded
    }

    // Standard Fiction Template
    const standardFiction = {
      categories: [
        { name: 'Characters', category: 'character', color: '#ef4444', tags: ['protagonist', 'antagonist', 'supporting-character', 'minor-character'] },
        { name: 'Settings', category: 'setting', color: '#f97316', tags: ['primary-location', 'secondary-location', 'time-period'] },
        { name: 'World Building', category: 'worldBuilding', color: '#14b8a6', tags: ['rules', 'culture', 'history', 'technology'] },
        { name: 'Tone', category: 'tone', color: '#3b82f6', tags: ['dramatic', 'humorous', 'suspenseful', 'romantic', 'dark', 'lighthearted'] },
        { name: 'Content', category: 'content', color: '#22c55e', tags: ['action', 'dialogue', 'description', 'internal-monologue', 'flashback'] },
        { name: 'Plot Threads', category: 'plot-thread', color: '#a855f7', tags: ['main-plot', 'subplot', 'character-arc', 'mystery', 'romance-arc'] }
      ]
    };

    // Mystery Template
    const mystery = {
      categories: [
        { name: 'Characters', category: 'character', color: '#ef4444', tags: ['detective', 'suspect', 'victim', 'witness', 'accomplice'] },
        { name: 'Settings', category: 'setting', color: '#f97316', tags: ['crime-scene', 'investigation-location', 'hideout'] },
        { name: 'World Building', category: 'worldBuilding', color: '#14b8a6', tags: ['police-procedure', 'forensics', 'legal-system'] },
        { name: 'Tone', category: 'tone', color: '#3b82f6', tags: ['suspenseful', 'noir', 'cozy', 'psychological'] },
        { name: 'Content', category: 'content', color: '#22c55e', tags: ['clue', 'red-herring', 'revelation', 'interrogation', 'deduction'] },
        { name: 'Plot Threads', category: 'plot-thread', color: '#a855f7', tags: ['main-mystery', 'personal-stakes', 'ticking-clock', 'twist'] }
      ]
    };

    // Fantasy Template
    const fantasy = {
      categories: [
        { name: 'Characters', category: 'character', color: '#ef4444', tags: ['hero', 'mentor', 'villain', 'magical-creature', 'ally'] },
        { name: 'Settings', category: 'setting', color: '#f97316', tags: ['kingdom', 'magical-realm', 'dungeon', 'village', 'wilderness'] },
        { name: 'World Building', category: 'worldBuilding', color: '#14b8a6', tags: ['magic-system', 'mythology', 'races', 'politics', 'prophecy'] },
        { name: 'Tone', category: 'tone', color: '#3b82f6', tags: ['epic', 'dark-fantasy', 'whimsical', 'gritty'] },
        { name: 'Content', category: 'content', color: '#22c55e', tags: ['battle', 'magic-use', 'quest', 'world-building-exposition', 'training'] },
        { name: 'Plot Threads', category: 'plot-thread', color: '#a855f7', tags: ['heroes-journey', 'magical-quest', 'war', 'coming-of-age', 'political-intrigue'] }
      ]
    };

    // Sci-Fi Template
    const sciFi = {
      categories: [
        { name: 'Characters', category: 'character', color: '#ef4444', tags: ['captain', 'scientist', 'android', 'alien', 'pilot'] },
        { name: 'Settings', category: 'setting', color: '#f97316', tags: ['spaceship', 'space-station', 'alien-planet', 'colony', 'laboratory'] },
        { name: 'World Building', category: 'worldBuilding', color: '#14b8a6', tags: ['technology', 'alien-species', 'faster-than-light-travel', 'time-travel', 'AI'] },
        { name: 'Tone', category: 'tone', color: '#3b82f6', tags: ['hard-sci-fi', 'space-opera', 'cyberpunk', 'dystopian', 'hopeful'] },
        { name: 'Content', category: 'content', color: '#22c55e', tags: ['space-battle', 'scientific-discovery', 'first-contact', 'tech-explanation', 'survival'] },
        { name: 'Plot Threads', category: 'plot-thread', color: '#a855f7', tags: ['exploration', 'invasion', 'rebellion', 'mystery', 'ethical-dilemma'] }
      ]
    };

    // Create templates
    this.createTagTemplate('Standard Fiction', JSON.stringify(standardFiction), true);
    this.createTagTemplate('Mystery', JSON.stringify(mystery), true);
    this.createTagTemplate('Fantasy', JSON.stringify(fantasy), true);
    this.createTagTemplate('Sci-Fi', JSON.stringify(sciFi), true);
  }

  // ============= UTILITY METHODS =============

  private getNextPosition(parentId: string | null): number {
    const result = this.db.prepare(`
      SELECT MAX(position) as max_pos FROM documents WHERE parent_id IS ?
    `).get(parentId) as { max_pos: number | null };

    return (result.max_pos ?? -1) + 1;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  close() {
    this.db.close();
  }

  // For debugging
  vacuum() {
    this.db.exec('VACUUM');
  }
}

export default ProjectDatabase;