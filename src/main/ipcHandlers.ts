// src/main/ipcHandlers.ts
import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import ProjectDatabase from './database';

let currentDb: ProjectDatabase | null = null;

export function setupIpcHandlers() {
  // ============= PROJECT OPERATIONS =============

  ipcMain.handle('project:create', async (_, projectName: string) => {
    try {
      const { filePath } = await dialog.showSaveDialog({
        title: 'Create New Project',
        defaultPath: path.join(app.getPath('documents'), 'Mythscribe', `${projectName}.mythscribe`),
        filters: [{ name: 'Mythscribe Project', extensions: ['mythscribe'] }],
        properties: ['createDirectory']
      });

      if (!filePath) return null;

      // Close existing database if any
      if (currentDb) {
        currentDb.close();
      }

      // Create new database
      currentDb = new ProjectDatabase(filePath);
      const projectId = currentDb.createProject(projectName);

      return { projectId, projectPath: filePath };
    } catch (error) {
      console.error('Error creating project:', error);
      throw error;
    }
  });

  ipcMain.handle('project:open', async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        title: 'Open Project',
        filters: [{ name: 'Mythscribe Project', extensions: ['mythscribe'] }],
        properties: ['openFile']
      });

      if (!filePaths || filePaths.length === 0) return null;

      // Close existing database if any
      if (currentDb) {
        currentDb.close();
      }

      // Open database
      currentDb = new ProjectDatabase(filePaths[0]);
      currentDb.updateLastOpened();

      const metadata = currentDb.getProjectMetadata();
      return { metadata, projectPath: filePaths[0] };
    } catch (error) {
      console.error('Error opening project:', error);
      throw error;
    }
  });

  ipcMain.handle('project:getMetadata', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getProjectMetadata();
  });

  ipcMain.handle('project:close', async () => {
    if (currentDb) {
      currentDb.close();
      currentDb = null;
    }
  });

  // ============= DOCUMENT OPERATIONS =============

  ipcMain.handle('document:create', async (_, name: string, parentId: string | null, docType: 'manuscript' | 'note') => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createDocument(name, parentId, docType);
  });

  ipcMain.handle('folder:create', async (_, name: string, parentId: string | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createFolder(name, parentId);
  });

  ipcMain.handle('document:get', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocument(id);
  });

  ipcMain.handle('document:getByParent', async (_, parentId: string | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocumentsByParent(parentId);
  });

  ipcMain.handle('document:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllDocuments();
  });

  ipcMain.handle('document:updateContent', async (_, id: string, content: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentContent(id, content);
  });

  ipcMain.handle('document:updateName', async (_, id: string, name: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentName(id, name);
  });

  ipcMain.handle('document:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteDocument(id);
  });

  ipcMain.handle('document:move', async (_, id: string, newParentId: string | null, newPosition: number) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.moveDocument(id, newParentId, newPosition);
  });

  // ============= REFERENCE OPERATIONS =============

  ipcMain.handle('reference:create', async (_, name: string, category: 'character' | 'setting' | 'worldBuilding', content: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createReference(name, category, content);
  });

  ipcMain.handle('reference:get', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getReference(id);
  });

  ipcMain.handle('reference:getByCategory', async (_, category: 'character' | 'setting' | 'worldBuilding') => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getReferencesByCategory(category);
  });

  ipcMain.handle('reference:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllReferences();
  });

  ipcMain.handle('reference:update', async (_, id: string, content: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateReference(id, content);
  });

  ipcMain.handle('reference:updateName', async (_, id: string, name: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateReferenceName(id, name);
  });

  ipcMain.handle('reference:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteReference(id);
  });

  // ============= SETTINGS OPERATIONS =============

  ipcMain.handle('settings:get', async (_, key: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getSetting(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.setSetting(key, value);
  });
}

export function closeDatabase() {
  if (currentDb) {
    currentDb.close();
    currentDb = null;
  }
}