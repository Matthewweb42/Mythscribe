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

  private initializeTables() {
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

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