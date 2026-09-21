import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel, type HierarchyLevel } from '@shared/labels'
import {
  DOCS_URL,
  EDIT_ROLES,
  isMenuItemEnabled,
  menuItems,
  type EditRole,
  type MenuItemId
} from '@shared/menu'
import type { FloatingPanel } from '@shared/layout'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { resolveCreateTarget } from '@renderer/features/manuscript/placement'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useWelcomeStore } from '@renderer/features/project/welcomeStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useUpdateStore } from '@renderer/features/updates/updateStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** What a `project` item says when it runs with nothing open (a native accelerator can still reach it). */
export const NO_PROJECT_MESSAGE = 'Open a project first.'

const isEditRole = (id: MenuItemId): id is EditRole =>
  (EDIT_ROLES as readonly string[]).includes(id)

/**
 * Runs one menu item (F-7.1), whether it came from the in-app bar or the native menu's
 * `menu:action` event: the one map from `MenuItemId` to the stores that already own each
 * behaviour, so the menu never has a second implementation of anything. A `project` item with
 * no project open toasts instead of running; a failure toasts its cause.
 */
export async function runMenuAction(id: MenuItemId): Promise<void> {
  const project = useProjectStore.getState().current
  const item = menuItems().find((entry) => entry.id === id)
  if (item && !isMenuItemEnabled(item, project !== null)) {
    toast.warning(NO_PROJECT_MESSAGE)
    return
  }
  try {
    if (isEditRole(id)) {
      await ipc().invoke('menu:edit', { role: id })
      return
    }
    switch (id) {
      case 'newProject':
        if (project && !(await closeProjectWithConfirm())) return
        useWelcomeStore.getState().setCreating(true)
        return
      case 'openProject': {
        if (project && !(await closeProjectWithConfirm())) return
        const info = await useProjectStore.getState().open()
        if (info) toast.success(`Opened "${info.name}"`)
        return
      }
      case 'openDocumentation':
        await ipc().invoke('menu:openExternal', { url: DOCS_URL })
        return
      case 'openShortcuts':
        useShellDialogStore.getState().show('shortcuts')
        return
      case 'openAbout':
        useShellDialogStore.getState().show('about')
        return
      case 'openSettings':
        // App-wide since F-15.2: without a project the dialog shows only the app-wide tabs.
        useShellDialogStore.getState().show('settings')
        return
      case 'checkForUpdates':
        // F-15.7: the Updates tab is where the answer shows, so it opens with the check.
        useShellDialogStore.getState().show('settings', 'updates')
        await useUpdateStore.getState().check()
        return
      default:
        break
    }
    if (!project) return
    switch (id) {
      case 'saveDocument':
        await useDocumentStore.getState().saveNow()
        return
      case 'closeProject':
        await closeProjectWithConfirm()
        return
      case 'insertScene':
        insertLevel('scene', project.format)
        return
      case 'insertChapter':
        insertLevel('chapter', project.format)
        return
      case 'insertPart':
        insertLevel('part', project.format)
        return
      case 'insertSceneBreak': {
        const active = useActiveEditorStore.getState().active
        if (!active) {
          toast.warning('Select a document to insert the scene break into.')
          return
        }
        active.editor.chain().focus().insertSceneBreak().run()
        return
      }
      case 'toggleSidebar':
        useLayoutStore.getState().toggle('sidebar')
        return
      case 'toggleNotes':
        togglePanel('notes')
        return
      case 'toggleAssistant':
        togglePanel('assistant')
        return
      case 'toggleFocusMode':
        await useFocusStore.getState().toggle()
        return
      case 'openTags': {
        const focus = useFocusStore.getState()
        if (focus.active) await focus.exit()
        const layout = useLayoutStore.getState()
        layout.setSidebarTab('tags')
        if (!layout.layout.sidebar.open) layout.toggle('sidebar')
        return
      }
    }
  } catch (err) {
    toast.error(describeError(err))
  }
}

/**
 * View › Notes / AI assistant: in focus mode the panels float on the focus store's own flags
 * (F-6.5), on the normal screen they dock on the persisted layout (F-7.2).
 */
function togglePanel(panel: FloatingPanel): void {
  const focus = useFocusStore.getState()
  if (focus.active) focus.togglePanel(panel)
  else useLayoutStore.getState().toggle(panel)
}

/**
 * Insert › Scene / Chapter / Part and the F-2.7 chords: creates the level relative to the
 * current selection through the create bar's placement rule (`createLevel` resolves against
 * `selectedId`), with inline rename. When the selection cannot take the level (front or end
 * matter, nothing selected in an empty manuscript) a toast says what to select.
 */
export function insertLevel(level: HierarchyLevel, format: NovelFormat): void {
  const tree = useTreeStore.getState()
  if (!resolveCreateTarget(tree, tree.selectedId, level)) {
    toast.warning(
      `Select something in the manuscript to insert the ${levelLabel(format, level).toLowerCase()} after it.`
    )
    return
  }
  tree.createLevel(level).catch((err: unknown) => toast.error(describeError(err)))
}

/**
 * File › Close project and the header button: confirms, then closes (everything is already
 * saved). Answers whether the project was closed; a refused confirm or a failed close (which
 * toasts) answers false.
 */
export async function closeProjectWithConfirm(): Promise<boolean> {
  const ok = await dialogs.confirm({
    title: 'Close project',
    message: 'Everything is saved automatically. Close it now?',
    confirmLabel: 'Close'
  })
  if (!ok) return false
  try {
    await useProjectStore.getState().close()
    return true
  } catch (err) {
    toast.error(describeError(err))
    return false
  }
}
