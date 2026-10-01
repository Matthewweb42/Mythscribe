import { app, dialog, type BrowserWindow } from 'electron'
import path from 'node:path'
import { IMAGE_EXTENSIONS } from '@shared/assets'
import { ENTITY_EXCHANGE_EXTENSIONS } from '@shared/entityExchange'
import { BACKGROUND_EXTENSIONS } from '@shared/focus'
import { IMPORT_EXTENSIONS } from '@shared/import'
import { DB_FILE, PROJECT_EXTENSION, sanitizeName } from './project/projectStore'

export interface ProjectDialogs {
  /** Returns the full project folder path the user chose, or null if cancelled. */
  chooseProjectSavePath: (name: string) => Promise<string | null>
  /** Returns the project folder (or project.db) the user chose, or null if cancelled. */
  chooseProjectToOpen: () => Promise<string | null>
  /**
   * Returns the file path the user chose for an export (F-14.6), or null if cancelled.
   * `defaultName` lands in `directory` when given, else the MythScribe documents folder.
   */
  chooseExportPath: (
    defaultName: string,
    filters: Electron.FileFilter[],
    directory?: string
  ) => Promise<string | null>
  /**
   * Returns the image files the user chose (F-6.2 focus-mode backgrounds, the default title;
   * F-9.6 pinned reference images pass their own), or null if cancelled.
   */
  chooseImages: (title?: string) => Promise<string[] | null>
  /** Returns the one image the user chose for an entity (F-9.3), or null if cancelled. */
  chooseEntityImage: () => Promise<string | null>
  /** Returns the manuscript file the user chose to import (F-12.2), or null if cancelled. */
  chooseManuscriptFile: () => Promise<string | null>
  /** Returns the entity library or CSV the user chose to import (F-9.5), or null if cancelled. */
  chooseEntityLibraryFile: () => Promise<string | null>
}

export function createDialogs(getWindow: () => BrowserWindow | null): ProjectDialogs {
  const show = <T>(fn: (win: BrowserWindow | undefined) => Promise<T>): Promise<T> =>
    fn(getWindow() ?? undefined)
  // App paths are only valid at call time, so both dialogs compute the default on demand.
  const defaultDir = (): string => path.join(app.getPath('documents'), 'MythScribe')
  return {
    async chooseProjectSavePath(name) {
      const options = saveOptions(defaultDir(), name)
      const result = await show((win) =>
        win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
      )
      if (result.canceled || !result.filePath) return null
      const chosen = result.filePath
      return chosen.endsWith(PROJECT_EXTENSION) ? chosen : `${chosen}${PROJECT_EXTENSION}`
    },
    async chooseProjectToOpen() {
      const options = openOptions(defaultDir())
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      )
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    },
    async chooseExportPath(defaultName, filters, directory) {
      const options: Electron.SaveDialogOptions = {
        title: 'Export',
        defaultPath: path.join(directory ?? defaultDir(), defaultName),
        buttonLabel: 'Export',
        filters,
        properties: ['createDirectory', 'showOverwriteConfirmation']
      }
      const result = await show((win) =>
        win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
      )
      if (result.canceled || !result.filePath) return null
      return result.filePath
    },
    async chooseImages(title = 'Add background images') {
      const options: Electron.OpenDialogOptions = {
        title,
        buttonLabel: 'Add',
        defaultPath: app.getPath('pictures'),
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: [...BACKGROUND_EXTENSIONS] }]
      }
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      )
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths
    },
    async chooseEntityImage() {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose an image',
        buttonLabel: 'Choose',
        defaultPath: app.getPath('pictures'),
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }]
      }
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      )
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    },
    async chooseManuscriptFile() {
      const options = importOptions(defaultDir())
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      )
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    },
    async chooseEntityLibraryFile() {
      const options = entityLibraryOptions(defaultDir())
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
      )
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    }
  }
}

/** The entity files the importer reads (F-9.5): a MythScribe library, or a CSV of one kind. */
function entityLibraryOptions(defaultDir: string): Electron.OpenDialogOptions {
  const extensions = Object.values(ENTITY_EXCHANGE_EXTENSIONS)
  return {
    title: 'Import entities',
    buttonLabel: 'Import',
    defaultPath: defaultDir,
    properties: ['openFile'],
    filters: [
      { name: `Entity files (${extensions.map((e) => `*.${e}`).join(', ')})`, extensions },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/** The formats the importer reads (F-12.2), named so the author can see what to look for. */
function importOptions(defaultDir: string): Electron.OpenDialogOptions {
  const extensions = Object.values(IMPORT_EXTENSIONS).flatMap((list) => [...list])
  return {
    title: 'Import manuscript',
    buttonLabel: 'Import',
    defaultPath: defaultDir,
    properties: ['openFile'],
    filters: [
      { name: `Manuscripts (${extensions.map((e) => `*.${e}`).join(', ')})`, extensions },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/** The author picks `project.db` inside a project folder, or a v0 single `.mythscribe` file. */
function openOptions(defaultDir: string): Electron.OpenDialogOptions {
  return {
    title: 'Open project',
    buttonLabel: 'Open',
    defaultPath: defaultDir,
    properties: ['openFile'],
    filters: [
      {
        name: `MythScribe project (${DB_FILE}, *${PROJECT_EXTENSION})`,
        extensions: ['db', 'mythscribe']
      },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

function saveOptions(defaultDir: string, name: string): Electron.SaveDialogOptions {
  return {
    title: 'Create project',
    defaultPath: path.join(defaultDir, `${sanitizeName(name)}${PROJECT_EXTENSION}`),
    buttonLabel: 'Create',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
}
