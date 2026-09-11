import { app, type BrowserWindow } from 'electron'
import type { AppStateStore } from '../appState/appStateStore'
import { removeRecent, toRecentEntry, touchRecent, withExists } from '../appState/recents'
import type { ProjectDialogs } from '../dialogs'
import type { ProjectManager } from '../project/manager'
import { isProjectFolder, projectFolderFor } from '../project/projectStore'
import { listNodes, toTreeNode } from '../tree/treeStore'
import { emit, register } from './registry'

export interface HandlerDeps {
  manager: ProjectManager
  appState: AppStateStore
  dialogs: ProjectDialogs
  windows: () => BrowserWindow[]
}

export function registerHandlers({ manager, appState, dialogs, windows }: HandlerDeps): void {
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

  register('recents:list', () => withExists(appState.get().recents, isProjectFolder))

  register('recents:remove', ({ path }) => {
    const next = appState.update((s) => ({ ...s, recents: removeRecent(s.recents, path) }))
    return withExists(next.recents, isProjectFolder)
  })

  register('tree:list', () => listNodes(manager.require().connection.orm).map(toTreeNode))

  manager.onChange((info) => {
    if (info) {
      try {
        appState.update((s) => ({ ...s, recents: touchRecent(s.recents, toRecentEntry(info)) }))
      } catch (err) {
        console.warn('Could not record recent project', err)
      }
    }
    emit(windows(), 'project:changed', info)
  })
}
