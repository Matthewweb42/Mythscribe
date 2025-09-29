// src/renderer/types/index.ts

export interface Project {
  id: string;
  name: string;
  created: Date;
  modified: Date;
  rootFolder: Folder;
  references: References;
}

export interface Folder {
  id: string;
  name: string;
  type: 'folder';
  children: (Folder | Document)[];
}

export interface Document {
  id: string;
  name: string;
  type: 'document';
  content: any; // Slate content (JSON)
  docType: 'manuscript' | 'note';
}

export interface References {
  characters: ReferenceDoc[];
  settings: ReferenceDoc[];
  worldBuilding: ReferenceDoc[];
}

export interface ReferenceDoc {
  id: string;
  name: string;
  content: string;
  category: 'character' | 'setting' | 'worldBuilding';
}

export type TreeItem = Folder | Document;

export interface AISettings {
  enabled: boolean;
  provider: 'openai' | 'anthropic';
  model: string;
  temperature: number;
  suggestionDelay: number; // milliseconds before showing ghost text
}

export interface EditorMode {
  mode: 'freewrite' | 'vibewrite';
}