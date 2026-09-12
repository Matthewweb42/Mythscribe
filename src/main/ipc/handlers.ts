import { app } from 'electron'
import type { AppStateStore } from '../appState/appStateStore'
import { removeRecent, toRecentEntry, touchRecent, withExists } from '../appState/recents'
import type { ProjectDialogs } from '../dialogs'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { getNotes, saveNotes } from '../document/notesStore'
import type { ProjectManager } from '../project/manager'
import { isProjectFolder, projectFolderFor } from '../project/projectStore'
import { getEditorSettings, setEditorSettings } from '../project/settingsStore'
import { fitsEditorMin, normalizeLayout } from '@shared/layout'
import {
  createNode,
  deleteNode,
  duplicateNode,
  listNodes,
  moveNode,
  renameNode,
  toTreeNode
} from '../tree/treeStore'
import { AppError } from './errors'
import { emit, register, type EmitTarget } from './registry'

/** The parts of a BrowserWindow the handlers need; structural so tests can pass a fake. */
export interface ClosableWindow extends EmitTarget {
  close(): void
}

export interface HandlerDeps {
  manager: ProjectManager
  appState: AppStateStore
  dialogs: ProjectDialogs
  windows: () => ClosableWindow[]
  /** The renderer abandoned a window close (its flush failed); forget any quit that asked for it. */
  onCloseCancelled: () => void
}

export function registerHandlers({
  manager,
  appState,
  dialogs,
  windows,
  onCloseCancelled
}: HandlerDeps): void {
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

  register('tree:create', (input) => {
    const session = manager.require()
    return toTreeNode(createNode(session.connection.orm, session.info.format, input))
  })

  register('tree:rename', ({ id, title }) =>
    toTreeNode(renameNode(manager.require().connection.orm, id, title))
  )

  register('tree:duplicate', ({ id }) =>
    duplicateNode(manager.require().connection.orm, id).map(toTreeNode)
  )

  register('tree:delete', ({ id }) => {
    deleteNode(manager.require().connection.orm, id)
    return null
  })

  register('tree:move', ({ id, parentId, afterId }) =>
    toTreeNode(moveNode(manager.require().connection.orm, id, parentId, afterId))
  )

  register('document:get', ({ id }) => getDocumentContent(manager.require().connection.orm, id))

  register('document:save', ({ id, content }) =>
    saveDocument(manager.require().connection.orm, id, content)
  )

  register('notes:get', ({ id }) => getNotes(manager.require().connection.orm, id))

  register('notes:save', ({ id, notes }) => saveNotes(manager.require().connection.orm, id, notes))

  register('editorSettings:get', () => {
    const session = manager.require()
    return getEditorSettings(session.connection.orm, session.info.format)
  })

  register('editorSettings:set', (value) =>
    setEditorSettings(manager.require().connection.orm, value)
  )

  // A hand-edited app-state file may squeeze the editor; reading normalizes, writing refuses.
  register('layout:get', () => normalizeLayout(appState.get().layout))

  register('layout:set', (layout) => {
    if (!fitsEditorMin(layout)) {
      throw new AppError('VALIDATION', 'The panels leave the editor less than its minimum width')
    }
    return appState.update((s) => ({ ...s, layout })).layout
  })

  register('window:close', () => {
    manager.close()
    for (const w of windows()) if (!w.isDestroyed()) w.close()
    return null
  })

  register('window:close-cancelled', () => {
    onCloseCancelled()
    return null
  })

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
