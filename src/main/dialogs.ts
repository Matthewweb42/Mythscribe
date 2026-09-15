import { app, dialog, type BrowserWindow } from 'electron'
import path from 'node:path'
import { BACKGROUND_EXTENSIONS } from '@shared/focus'
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
  /** Returns the image files the user chose for focus-mode backgrounds (F-6.2), or null if cancelled. */
  chooseImages: () => Promise<string[] | null>
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
    async chooseImages() {
      const options: Electron.OpenDialogOptions = {
        title: 'Add background images',
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
    }
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
