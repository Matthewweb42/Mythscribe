// src/main/database.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface ProjectMetadata {
  id: string;
  name: string;
  novel_format: 'novel' | 'epic' | 'webnovel';
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
  location: string | null; // Scene location/setting (tag name)
  pov: string | null; // Scene POV character (tag name)
  timeline_position: string | null; // Scene position in timeline (free text for now)
  scene_metadata: string | null; // JSON for additional custom metadata
  section: 'front-matter' | 'manuscript' | 'end-matter' | null; // Three-section structure
  matter_type: string | null; // Type of front/end matter (e.g., 'title-page', 'acknowledgments')
  formatting_preset: string | null; // JSON string with formatting settings for this document
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
  private projectFolderPath: string;

  constructor(dbPath: string, projectFolderPath?: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Store project folder path (for resolving relative asset paths)
    // If not provided, use the parent directory of the database file
    this.projectFolderPath = projectFolderPath || path.dirname(dbPath);

    this.initializeTables();
  }

  getProjectFolderPath(): string {
    return this.projectFolderPath;
  }

  // Migrate asset paths from absolute to relative
  migrateAssetPaths() {
    try {
      const assets = this.getAssetsByType('background-image');

      assets.forEach(asset => {
        // Skip if already a relative path
        if (!path.isAbsolute(asset.file_path)) {
          return;
        }

        // Check if file exists at absolute path
        if (fs.existsSync(asset.file_path)) {
          const fileName = path.basename(asset.file_path);
          const relativePath = path.join('assets', 'backgrounds', fileName);

          // Update to relative path
          this.db.prepare(`
            UPDATE project_assets
            SET file_path = ?
            WHERE id = ?
          `).run(relativePath, asset.id);

          console.log(`Migrated asset path: ${asset.file_path} -> ${relativePath}`);
        } else {
          // File doesn't exist, try to find it by filename in new location
          const fileName = path.basename(asset.file_path);
          const newPath = path.join(this.projectFolderPath, 'assets', 'backgrounds', fileName);

          if (fs.existsSync(newPath)) {
            const relativePath = path.join('assets', 'backgrounds', fileName);
            this.db.prepare(`
              UPDATE project_assets
              SET file_path = ?
              WHERE id = ?
            `).run(relativePath, asset.id);

            console.log(`Fixed missing asset path: ${relativePath}`);
          } else {
            console.warn(`Asset file not found, removing from database: ${asset.file_path}`);
            this.deleteAsset(asset.id);
          }
        }
      });
    } catch (error) {
      console.error('Error migrating asset paths:', error);
    }
  }

  private runMigrations() {
    // Check if project table exists for project-related migrations
    const projectTableInfo = this.db.pragma('table_info(project)') as Array<{ name: string }>;

    if (projectTableInfo.length > 0) {
      // Check and add novel_format column to project table
      const hasNovelFormat = projectTableInfo.some((col) => col.name === 'novel_format');
      if (!hasNovelFormat) {
        console.log('Running migration: Adding novel_format column to project table');
        try {
          this.db.exec(`
            ALTER TABLE project
            ADD COLUMN novel_format TEXT NOT NULL DEFAULT 'novel' CHECK(novel_format IN ('novel', 'epic', 'webnovel'))
          `);
          console.log('Migration completed: novel_format column added');
        } catch (error) {
          console.error('Migration error (novel_format):', error);
        }
      }
    }

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

    // Check and add location column
    const hasLocation = tableInfo.some((col) => col.name === 'location');
    if (!hasLocation) {
      console.log('Running migration: Adding location column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN location TEXT
        `);
        console.log('Migration completed: location column added');
      } catch (error) {
        console.error('Migration error (location):', error);
      }
    }

    // Check and add pov column
    const hasPov = tableInfo.some((col) => col.name === 'pov');
    if (!hasPov) {
      console.log('Running migration: Adding pov column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN pov TEXT
        `);
        console.log('Migration completed: pov column added');
      } catch (error) {
        console.error('Migration error (pov):', error);
      }
    }

    // Check and add timeline_position column
    const hasTimelinePosition = tableInfo.some((col) => col.name === 'timeline_position');
    if (!hasTimelinePosition) {
      console.log('Running migration: Adding timeline_position column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN timeline_position TEXT
        `);
        console.log('Migration completed: timeline_position column added');
      } catch (error) {
        console.error('Migration error (timeline_position):', error);
      }
    }

    // Check and add scene_metadata column
    const hasSceneMetadata = tableInfo.some((col) => col.name === 'scene_metadata');
    if (!hasSceneMetadata) {
      console.log('Running migration: Adding scene_metadata column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN scene_metadata TEXT
        `);
        console.log('Migration completed: scene_metadata column added');
      } catch (error) {
        console.error('Migration error (scene_metadata):', error);
      }
    }

    // Check and add section column
    const hasSection = tableInfo.some((col) => col.name === 'section');
    if (!hasSection) {
      console.log('Running migration: Adding section column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN section TEXT CHECK(section IN ('front-matter', 'manuscript', 'end-matter', NULL))
        `);
        console.log('Migration completed: section column added');
      } catch (error) {
        console.error('Migration error (section):', error);
      }
    }

    // Check and add matter_type column
    const hasMatterType = tableInfo.some((col) => col.name === 'matter_type');
    if (!hasMatterType) {
      console.log('Running migration: Adding matter_type column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN matter_type TEXT
        `);
        console.log('Migration completed: matter_type column added');
      } catch (error) {
        console.error('Migration error (matter_type):', error);
      }
    }

    // Check and add formatting_preset column
    const hasFormattingPreset = tableInfo.some((col) => col.name === 'formatting_preset');
    if (!hasFormattingPreset) {
      console.log('Running migration: Adding formatting_preset column to documents table');
      try {
        this.db.exec(`
          ALTER TABLE documents
          ADD COLUMN formatting_preset TEXT
        `);
        console.log('Migration completed: formatting_preset column added');
      } catch (error) {
        console.error('Migration error (formatting_preset):', error);
      }
    }

    // Create three root folders if they don't exist (for existing projects)
    this.ensureThreeSectionStructure();

    // Add focus mode columns to project table
    if (projectTableInfo.length > 0) {
      const hasFocusBgRotation = projectTableInfo.some((col) => col.name === 'focus_bg_rotation');
      if (!hasFocusBgRotation) {
        console.log('Running migration: Adding focus mode columns to project table');
        try {
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_bg_rotation INTEGER DEFAULT 0;
          `);
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_bg_rotation_interval INTEGER DEFAULT 10;
          `);
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_bg_current TEXT;
          `);
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_overlay_opacity INTEGER DEFAULT 50;
          `);
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_window_width INTEGER DEFAULT 60;
          `);
          this.db.exec(`
            ALTER TABLE project ADD COLUMN focus_window_offset_x INTEGER DEFAULT 0;
          `);
          console.log('Migration completed: focus mode columns added');
        } catch (error) {
          console.error('Migration error (focus mode columns):', error);
        }
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
        novel_format TEXT NOT NULL DEFAULT 'novel' CHECK(novel_format IN ('novel', 'epic', 'webnovel')),
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        last_opened TEXT NOT NULL,
        focus_bg_rotation INTEGER DEFAULT 0,
        focus_bg_rotation_interval INTEGER DEFAULT 10,
        focus_bg_current TEXT,
        focus_overlay_opacity INTEGER DEFAULT 50,
        focus_window_width INTEGER DEFAULT 50,
        focus_window_offset_x INTEGER DEFAULT 0
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
        location TEXT,
        pov TEXT,
        timeline_position TEXT,
        scene_metadata TEXT,
        section TEXT CHECK(section IN ('front-matter', 'manuscript', 'end-matter', NULL)),
        matter_type TEXT,
        formatting_preset TEXT,
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

    // Project Assets (background images, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_assets (
        id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL CHECK(asset_type IN ('background-image')),
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        created TEXT NOT NULL
      )
    `);

    // Create index for faster asset lookups by type
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_asset_type
      ON project_assets(asset_type)
    `);
  }

  // ============= PROJECT OPERATIONS =============

  createProject(name: string, format: 'novel' | 'epic' | 'webnovel' = 'novel'): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO project (id, name, novel_format, created, modified, last_opened)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, format, now, now, now);

    // Create three-section structure (Front Matter, Manuscript, End Matter)
    this.createThreeSectionStructure(format);

    // Seed default tag templates
    this.seedDefaultTagTemplates();

    // Seed default editor formatting settings based on format
    this.seedDefaultEditorSettings(format);

    // Seed initial project structure based on format
    this.seedProjectStructure(format);

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

  createMatterDocument(
    name: string,
    parentId: string | null,
    section: 'front-matter' | 'end-matter',
    matterType: string,
    templateContent: string
  ): string {
    const id = this.generateId();
    const now = new Date().toISOString();
    const position = this.getNextPosition(parentId);

    const initialNotes = JSON.stringify([
      { type: 'paragraph', children: [{ text: '' }] }
    ]);

    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
      VALUES (?, ?, ?, 'document', ?, NULL, 'scene', ?, 0, ?, ?, ?, NULL, ?, ?)
    `).run(id, parentId, name, templateContent, initialNotes, position, section, matterType, now, now);

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

  updateDocumentMetadata(
    id: string,
    location: string | null,
    pov: string | null,
    timelinePosition: string | null
  ) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE documents
      SET location = ?, pov = ?, timeline_position = ?, modified = ?
      WHERE id = ?
    `).run(location, pov, timelinePosition, now, id);

    this.updateProjectModified();
  }

  getDocumentMetadata(id: string): {
    location: string | null;
    pov: string | null;
    timeline_position: string | null;
    scene_metadata: string | null;
  } | undefined {
    const row = this.db.prepare(`
      SELECT location, pov, timeline_position, scene_metadata
      FROM documents
      WHERE id = ?
    `).get(id) as {
      location: string | null;
      pov: string | null;
      timeline_position: string | null;
      scene_metadata: string | null;
    } | undefined;

    return row;
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

  seedDefaultEditorSettings(format: 'novel' | 'epic' | 'webnovel' = 'novel') {
    // Check if settings already exist
    const textSize = this.getSetting('editor_text_size');
    if (textSize) {
      return; // Already seeded
    }

    // Default editor formatting settings based on format
    // Novel & Epic: Traditional manuscript style (Scrivener-like)
    //   - No spacing between paragraphs
    //   - First-line indentation
    //   - Double-spaced lines
    // Web-novel: Modern web reading style
    //   - Spacing between paragraphs
    //   - No first-line indentation
    //   - More compact line spacing

    if (format === 'novel' || format === 'epic') {
      // Traditional manuscript formatting (like Scrivener)
      this.setSetting('editor_text_size', '16'); // 16px
      this.setSetting('editor_line_height', '2.0'); // Double-spaced
      this.setSetting('editor_paragraph_spacing', '0'); // No spacing between paragraphs
      this.setSetting('editor_paragraph_indent', '1.5'); // 1.5em first-line indent
      this.setSetting('editor_max_width', '700'); // 700px max width (book-like)
      this.setSetting('editor_scene_break_style', '* * *'); // Traditional scene break
    } else if (format === 'webnovel') {
      // Web-novel formatting (modern web reading)
      this.setSetting('editor_text_size', '16'); // 16px
      this.setSetting('editor_line_height', '1.6'); // Tighter line spacing
      this.setSetting('editor_paragraph_spacing', '1.0'); // 1.0em between paragraphs
      this.setSetting('editor_paragraph_indent', '0'); // No first-line indent
      this.setSetting('editor_max_width', '700'); // 700px max width (book-like)
      this.setSetting('editor_scene_break_style', '~~~'); // Modern scene break
    }
  }

  seedProjectStructure(format: 'novel' | 'epic' | 'webnovel') {
    // Get the Manuscript root folder
    const rootFolders = this.getDocumentsByParent(null);
    const manuscriptFolder = rootFolders.find(f => f.section === 'manuscript');
    if (!manuscriptFolder) return;

    const rootId = manuscriptFolder.id;

    if (format === 'novel' || format === 'epic') {
      // Novel/Epic: Manuscript → Part 1-2 → Chapter 1-3 each → Scene 1 each
      // Create Part 1 and Part 2
      for (let partNum = 1; partNum <= 2; partNum++) {
        const partId = this.createFolder(`Part ${partNum}`, rootId, 'part');

        // Create 3 chapters in each part
        for (let chapterNum = 1; chapterNum <= 3; chapterNum++) {
          const chapterId = this.createFolder(`Chapter ${chapterNum}`, partId, 'chapter');

          // Create 1 scene in each chapter
          this.createDocument(`Scene 1`, chapterId, 'manuscript', 'scene');
        }
      }
    } else if (format === 'webnovel') {
      // Web-novel: Volume 1 → Arc 1-2 → Chapter 1-3 each → Scene 1 each
      // Create Arc 1 and Arc 2 (stored as 'part' in hierarchy_level)
      for (let arcNum = 1; arcNum <= 2; arcNum++) {
        const arcId = this.createFolder(`Arc ${arcNum}`, rootId, 'part');

        // Create 3 chapters in each arc
        for (let chapterNum = 1; chapterNum <= 3; chapterNum++) {
          const chapterId = this.createFolder(`Chapter ${chapterNum}`, arcId, 'chapter');

          // Create 1 scene in each chapter
          this.createDocument(`Scene 1`, chapterId, 'manuscript', 'scene');
        }
      }
    }
  }

  // ============= THREE-SECTION STRUCTURE METHODS =============

  private createThreeSectionStructure(format: 'novel' | 'epic' | 'webnovel') {
    const now = new Date().toISOString();

    // Create Front Matter root folder (position 0, cannot be deleted/moved)
    const frontMatterId = this.generateId();
    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
      VALUES (?, NULL, 'Front Matter', 'folder', NULL, NULL, NULL, ?, 0, 0, 'front-matter', NULL, NULL, ?, ?)
    `).run(frontMatterId, JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]), now, now);

    // Create Manuscript root folder (position 1, cannot be deleted/moved)
    const manuscriptId = this.generateId();
    const manuscriptName = format === 'epic' ? 'Series' : format === 'webnovel' ? 'Volume 1' : 'Manuscript';
    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
      VALUES (?, NULL, ?, 'folder', NULL, NULL, NULL, ?, 0, 1, 'manuscript', NULL, NULL, ?, ?)
    `).run(manuscriptId, manuscriptName, JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]), now, now);

    // Create End Matter root folder (position 2, cannot be deleted/moved)
    const endMatterId = this.generateId();
    this.db.prepare(`
      INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
      VALUES (?, NULL, 'End Matter', 'folder', NULL, NULL, NULL, ?, 0, 2, 'end-matter', NULL, NULL, ?, ?)
    `).run(endMatterId, JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]), now, now);

    return { frontMatterId, manuscriptId, endMatterId };
  }

  private ensureThreeSectionStructure() {
    // Check if three root folders exist
    const rootFolders = this.getDocumentsByParent(null);

    // If there are already 3+ root folders with proper sections, assume structure is correct
    const hasFrontMatter = rootFolders.some(f => f.section === 'front-matter');
    const hasManuscript = rootFolders.some(f => f.section === 'manuscript');
    const hasEndMatter = rootFolders.some(f => f.section === 'end-matter');

    if (hasFrontMatter && hasManuscript && hasEndMatter) {
      return; // Structure already exists
    }

    console.log('Migrating existing project to three-section structure...');

    const now = new Date().toISOString();

    // If there's an existing root folder (old "Manuscript"), update it to be in manuscript section
    if (rootFolders.length > 0 && !hasManuscript) {
      const oldRoot = rootFolders[0];
      this.db.prepare(`
        UPDATE documents
        SET section = 'manuscript', position = 1, modified = ?
        WHERE id = ?
      `).run(now, oldRoot.id);
      console.log(`Migrated existing root folder "${oldRoot.name}" to Manuscript section`);
    }

    // Create Front Matter if it doesn't exist
    if (!hasFrontMatter) {
      const frontMatterId = this.generateId();
      this.db.prepare(`
        INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
        VALUES (?, NULL, 'Front Matter', 'folder', NULL, NULL, NULL, ?, 0, 0, 'front-matter', NULL, NULL, ?, ?)
      `).run(frontMatterId, JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]), now, now);
      console.log('Created Front Matter root folder');
    }

    // Create End Matter if it doesn't exist
    if (!hasEndMatter) {
      const endMatterId = this.generateId();
      this.db.prepare(`
        INSERT INTO documents (id, parent_id, name, type, content, doc_type, hierarchy_level, notes, word_count, position, section, matter_type, formatting_preset, created, modified)
        VALUES (?, NULL, 'End Matter', 'folder', NULL, NULL, NULL, ?, 0, 2, 'end-matter', NULL, NULL, ?, ?)
      `).run(endMatterId, JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]), now, now);
      console.log('Created End Matter root folder');
    }

    console.log('Three-section structure migration completed');
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

  // ============= PROJECT ASSETS OPERATIONS =============

  createAsset(
    assetType: 'background-image',
    fileName: string,
    filePath: string,
    fileSize: number,
    mimeType: string
  ): string {
    const id = this.generateId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO project_assets (id, asset_type, file_name, file_path, file_size, mime_type, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, assetType, fileName, filePath, fileSize, mimeType, now);

    return id;
  }

  getAssetsByType(assetType: 'background-image'): Array<{
    id: string;
    asset_type: string;
    file_name: string;
    file_path: string;
    file_size: number | null;
    mime_type: string | null;
    created: string;
  }> {
    return this.db.prepare(`
      SELECT * FROM project_assets
      WHERE asset_type = ?
      ORDER BY created DESC
    `).all(assetType) as Array<{
      id: string;
      asset_type: string;
      file_name: string;
      file_path: string;
      file_size: number | null;
      mime_type: string | null;
      created: string;
    }>;
  }

  deleteAsset(id: string) {
    this.db.prepare('DELETE FROM project_assets WHERE id = ?').run(id);
  }

  // ============= FOCUS SETTINGS OPERATIONS =============

  getFocusSettings(): {
    focus_bg_rotation: number;
    focus_bg_rotation_interval: number;
    focus_bg_current: string | null;
    focus_overlay_opacity: number;
    focus_window_width: number;
    focus_window_offset_x: number;
  } | undefined {
    const result = this.db.prepare(`
      SELECT
        focus_bg_rotation,
        focus_bg_rotation_interval,
        focus_bg_current,
        focus_overlay_opacity,
        focus_window_width,
        focus_window_offset_x
      FROM project
      LIMIT 1
    `).get() as {
      focus_bg_rotation: number;
      focus_bg_rotation_interval: number;
      focus_bg_current: string | null;
      focus_overlay_opacity: number;
      focus_window_width: number;
      focus_window_offset_x: number;
    } | undefined;

    return result;
  }

  updateFocusSetting(key: string, value: number | string | null) {
    const validKeys = [
      'focus_bg_rotation',
      'focus_bg_rotation_interval',
      'focus_bg_current',
      'focus_overlay_opacity',
      'focus_window_width',
      'focus_window_offset_x'
    ];

    if (!validKeys.includes(key)) {
      throw new Error(`Invalid focus setting key: ${key}`);
    }

    this.db.prepare(`UPDATE project SET ${key} = ?`).run(value);
    this.updateProjectModified();
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