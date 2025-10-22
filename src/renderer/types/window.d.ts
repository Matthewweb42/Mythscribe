// src/renderer/src/types/window.d.ts

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
  content: string | null;
  doc_type: 'manuscript' | 'note' | null;
  hierarchy_level: 'novel' | 'part' | 'chapter' | 'scene' | null;
  notes: string | null;
  word_count: number;
  position: number;
  location: string | null;
  pov: string | null;
  timeline_position: string | null;
  scene_metadata: string | null;
  section: 'front-matter' | 'manuscript' | 'end-matter' | null;
  matter_type: string | null;
  formatting_preset: string | null;
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

declare global {
  interface Window {
    api: {
      onMenuEvent: (callback: (event: string) => void) => void;
      project: {
        create: (projectName: string, format?: 'novel' | 'epic' | 'webnovel') => Promise<{ projectId: string; projectPath: string } | null>;
        open: () => Promise<{ metadata: ProjectMetadata; projectPath: string } | null>;
        getMetadata: () => Promise<ProjectMetadata>;
        close: () => Promise<void>;
      };
      document: {
        create: (name: string, parentId: string | null, docType: 'manuscript' | 'note', hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) => Promise<string>;
        createMatter: (name: string, parentId: string | null, section: 'front-matter' | 'end-matter', matterType: string, templateContent: string) => Promise<string>;
        get: (id: string) => Promise<DocumentRow | undefined>;
        getByParent: (parentId: string | null) => Promise<DocumentRow[]>;
        getAll: () => Promise<DocumentRow[]>;
        updateContent: (id: string, content: string) => Promise<void>;
        updateName: (id: string, name: string) => Promise<void>;
        updateNotes: (id: string, notes: string) => Promise<void>;
        updateWordCount: (id: string, wordCount: number) => Promise<void>;
        updateMetadata: (id: string, location: string | null, pov: string | null, timelinePosition: string | null) => Promise<void>;
        getMetadata: (id: string) => Promise<{
          location: string | null;
          pov: string | null;
          timeline_position: string | null;
          scene_metadata: string | null;
        } | undefined>;
        delete: (id: string) => Promise<void>;
        move: (id: string, newParentId: string | null, newPosition: number) => Promise<void>;
      };
      folder: {
        create: (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) => Promise<string>;
      };
      reference: {
        create: (name: string, category: 'character' | 'setting' | 'worldBuilding', content: string) => Promise<string>;
        get: (id: string) => Promise<ReferenceRow | undefined>;
        getByCategory: (category: 'character' | 'setting' | 'worldBuilding') => Promise<ReferenceRow[]>;
        getAll: () => Promise<ReferenceRow[]>;
        update: (id: string, content: string) => Promise<void>;
        updateName: (id: string, name: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
      };
      settings: {
        get: (key: string) => Promise<string | undefined>;
        set: (key: string, value: string) => Promise<void>;
      };
      ai: {
        generateSuggestion: (recentText: string, context?: {
          characterNotes?: string;
          settingNotes?: string;
          worldBuildingNotes?: string;
        }) => Promise<string>;
        testApiKey: () => Promise<{ success: boolean; message: string }>;
        generateDirected: (params: {
          instruction: string;
          paragraphCount: number;
          conversationHistory?: Array<{ role: string; content: string }>;
          referencedNotes?: string;
        }) => Promise<string>;
      };
    };
  }
}

export {};