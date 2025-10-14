// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Menu event listeners
  onMenuEvent: (callback: (event: string) => void) => {
    const menuEvents = [
      'menu:new-project', 'menu:open-project', 'menu:save',
      'menu:export-pdf', 'menu:export-docx', 'menu:export-epub', 'menu:export-markdown',
      'menu:import-document', 'menu:import-characters',
      'menu:find', 'menu:find-replace',
      'menu:insert-scene', 'menu:insert-chapter', 'menu:insert-part',
      'menu:insert-character', 'menu:insert-setting', 'menu:insert-worldbuilding',
      'menu:insert-scene-break',
      'menu:toggle-sidebar', 'menu:toggle-notes', 'menu:toggle-ai', 'menu:toggle-focus',
      'menu:word-count', 'menu:statistics', 'menu:goals', 'menu:tags',
      'menu:drafts', 'menu:snapshots', 'menu:settings',
      'menu:documentation', 'menu:shortcuts'
    ];

    menuEvents.forEach(event => {
      ipcRenderer.on(event, () => callback(event));
    });
  },
  // Project operations
  project: {
    create: (projectName: string) => ipcRenderer.invoke('project:create', projectName),
    open: () => ipcRenderer.invoke('project:open'),
    getMetadata: () => ipcRenderer.invoke('project:getMetadata'),
    close: () => ipcRenderer.invoke('project:close')
  },

  // Document operations
  document: {
    create: (name: string, parentId: string | null, docType: 'manuscript' | 'note', hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) =>
      ipcRenderer.invoke('document:create', name, parentId, docType, hierarchyLevel),
    get: (id: string) => ipcRenderer.invoke('document:get', id),
    getByParent: (parentId: string | null) => ipcRenderer.invoke('document:getByParent', parentId),
    getAll: () => ipcRenderer.invoke('document:getAll'),
    updateContent: (id: string, content: string) => ipcRenderer.invoke('document:updateContent', id, content),
    updateName: (id: string, name: string) => ipcRenderer.invoke('document:updateName', id, name),
    updateNotes: (id: string, notes: string) => ipcRenderer.invoke('document:updateNotes', id, notes),
    updateWordCount: (id: string, wordCount: number) => ipcRenderer.invoke('document:updateWordCount', id, wordCount),
    delete: (id: string) => ipcRenderer.invoke('document:delete', id),
    move: (id: string, newParentId: string | null, newPosition: number) =>
      ipcRenderer.invoke('document:move', id, newParentId, newPosition)
  },

  // Folder operations
  folder: {
    create: (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) =>
      ipcRenderer.invoke('folder:create', name, parentId, hierarchyLevel)
  },

  // Reference operations
  reference: {
    create: (name: string, category: 'character' | 'setting' | 'worldBuilding', content: string) =>
      ipcRenderer.invoke('reference:create', name, category, content),
    get: (id: string) => ipcRenderer.invoke('reference:get', id),
    getByCategory: (category: 'character' | 'setting' | 'worldBuilding') =>
      ipcRenderer.invoke('reference:getByCategory', category),
    getAll: () => ipcRenderer.invoke('reference:getAll'),
    update: (id: string, content: string) => ipcRenderer.invoke('reference:update', id, content),
    updateName: (id: string, name: string) => ipcRenderer.invoke('reference:updateName', id, name),
    delete: (id: string) => ipcRenderer.invoke('reference:delete', id)
  },

  // Settings operations
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value)
  },

  // Tag operations
  tag: {
    create: (name: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null, color?: string, parentTagId?: string | null) =>
      ipcRenderer.invoke('tag:create', name, category, color, parentTagId),
    get: (id: string) => ipcRenderer.invoke('tag:get', id),
    getAll: () => ipcRenderer.invoke('tag:getAll'),
    getByCategory: (category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom') =>
      ipcRenderer.invoke('tag:getByCategory', category),
    update: (id: string, name: string, color: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null) =>
      ipcRenderer.invoke('tag:update', id, name, color, category),
    delete: (id: string) => ipcRenderer.invoke('tag:delete', id),
    incrementUsage: (id: string) => ipcRenderer.invoke('tag:incrementUsage', id)
  },

  // Tag Template operations
  tagTemplate: {
    create: (name: string, tagsJson: string, isGlobal?: boolean) =>
      ipcRenderer.invoke('tagTemplate:create', name, tagsJson, isGlobal),
    getAll: () => ipcRenderer.invoke('tagTemplate:getAll'),
    delete: (id: string) => ipcRenderer.invoke('tagTemplate:delete', id)
  },

  // AI operations
  ai: {
    generateSuggestion: (recentText: string, context?: {
      characterNotes?: string;
      settingNotes?: string;
      worldBuildingNotes?: string;
    }) => ipcRenderer.invoke('ai:generate-suggestion', recentText, context),
    testApiKey: () => ipcRenderer.invoke('ai:test-api-key'),
    generateDirected: (params: {
      instruction: string;
      paragraphCount: number;
      conversationHistory?: Array<{ role: string; content: string }>;
      referencedNotes?: string;
    }) => ipcRenderer.invoke('ai:generate-directed', params)
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);

export type MythscribeAPI = typeof api;