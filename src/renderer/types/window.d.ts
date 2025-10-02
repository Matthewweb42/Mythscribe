// src/renderer/src/types/window.d.ts

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
  content: string | null;
  doc_type: 'manuscript' | 'note' | null;
  position: number;
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
      project: {
        create: (projectName: string) => Promise<{ projectId: string; projectPath: string } | null>;
        open: () => Promise<{ metadata: ProjectMetadata; projectPath: string } | null>;
        getMetadata: () => Promise<ProjectMetadata>;
        close: () => Promise<void>;
      };
      document: {
        create: (name: string, parentId: string | null, docType: 'manuscript' | 'note') => Promise<string>;
        get: (id: string) => Promise<DocumentRow | undefined>;
        getByParent: (parentId: string | null) => Promise<DocumentRow[]>;
        getAll: () => Promise<DocumentRow[]>;
        updateContent: (id: string, content: string) => Promise<void>;
        updateName: (id: string, name: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
        move: (id: string, newParentId: string | null, newPosition: number) => Promise<void>;
      };
      folder: {
        create: (name: string, parentId: string | null) => Promise<string>;
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
      };
    };
  }
}

export {};