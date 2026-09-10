import { app, dialog, type BrowserWindow } from 'electron'
import path from 'node:path'
import { PROJECT_EXTENSION, sanitizeName } from './project/projectStore'

export interface ProjectDialogs {
  /** Returns the full project folder path the user chose, or null if cancelled. */
  chooseProjectSavePath: (name: string) => Promise<string | null>
  /** Returns the project folder (or project.db) the user chose, or null if cancelled. */
  chooseProjectToOpen: () => Promise<string | null>
}

export function createDialogs(getWindow: () => BrowserWindow | null): ProjectDialogs {
  const show = <T>(fn: (win: BrowserWindow | undefined) => Promise<T>): Promise<T> =>
    fn(getWindow() ?? undefined)
  return {
    async chooseProjectSavePath(name) {
      const defaultDir = path.join(app.getPath('documents'), 'MythScribe')
      const result = await show((win) =>
        win
          ? dialog.showSaveDialog(win, saveOptions(defaultDir, name))
          : dialog.showSaveDialog(saveOptions(defaultDir, name))
      )
      if (result.canceled || !result.filePath) return null
      const chosen = result.filePath
      return chosen.endsWith(PROJECT_EXTENSION) ? chosen : `${chosen}${PROJECT_EXTENSION}`
    },
    async chooseProjectToOpen() {
      const result = await show((win) =>
        win ? dialog.showOpenDialog(win, openOptions) : dialog.showOpenDialog(openOptions)
      )
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    }
  }
}

const openOptions: Electron.OpenDialogOptions = {
  title: 'Open project',
  buttonLabel: 'Open',
  properties: ['openDirectory']
}

function saveOptions(defaultDir: string, name: string): Electron.SaveDialogOptions {
  return {
    title: 'Create project',
    defaultPath: path.join(defaultDir, `${sanitizeName(name)}${PROJECT_EXTENSION}`),
    buttonLabel: 'Create',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
}
