// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Project operations
  project: {
    create: (projectName: string) => ipcRenderer.invoke('project:create', projectName),
    open: () => ipcRenderer.invoke('project:open'),
    getMetadata: () => ipcRenderer.invoke('project:getMetadata'),
    close: () => ipcRenderer.invoke('project:close')
  },

  // Document operations
  document: {
    create: (name: string, parentId: string | null, docType: 'manuscript' | 'note') => 
      ipcRenderer.invoke('document:create', name, parentId, docType),
    get: (id: string) => ipcRenderer.invoke('document:get', id),
    getByParent: (parentId: string | null) => ipcRenderer.invoke('document:getByParent', parentId),
    getAll: () => ipcRenderer.invoke('document:getAll'),
    updateContent: (id: string, content: string) => ipcRenderer.invoke('document:updateContent', id, content),
    updateName: (id: string, name: string) => ipcRenderer.invoke('document:updateName', id, name),
    delete: (id: string) => ipcRenderer.invoke('document:delete', id),
    move: (id: string, newParentId: string | null, newPosition: number) => 
      ipcRenderer.invoke('document:move', id, newParentId, newPosition)
  },

  // Folder operations
  folder: {
    create: (name: string, parentId: string | null) => ipcRenderer.invoke('folder:create', name, parentId)
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

  // AI operations
  ai: {
    generateSuggestion: (recentText: string, context?: {
      characterNotes?: string;
      settingNotes?: string;
      worldBuildingNotes?: string;
    }) => ipcRenderer.invoke('ai:generate-suggestion', recentText, context),
    testApiKey: () => ipcRenderer.invoke('ai:test-api-key')
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', api);

export type MythscribeAPI = typeof api;