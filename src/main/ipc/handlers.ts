import { app, type BrowserWindow } from 'electron'
import type { ProjectDialogs } from '../dialogs'
import type { ProjectManager } from '../project/manager'
import { projectFolderFor } from '../project/projectStore'
import { emit, register } from './registry'

export interface HandlerDeps {
  manager: ProjectManager
  dialogs: ProjectDialogs
  windows: () => BrowserWindow[]
}

export function registerHandlers({ manager, dialogs, windows }: HandlerDeps): void {
  register('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  register('project:create', async ({ name, format, directory }) => {
    const folder = directory
      ? projectFolderFor(directory, name)
      : await dialogs.chooseProjectSavePath(name)
    if (!folder) return null
    return manager.create(folder, name, format)
  })

  register('project:open', async ({ path }) => {
    const folder = path ?? (await dialogs.chooseProjectToOpen())
    if (!folder) return null
    return manager.open(folder)
  })

  register('project:close', () => {
    manager.close()
    return null
  })

  register('project:current', () => manager.current())

  manager.onChange((info) => emit(windows(), 'project:changed', info))
}
