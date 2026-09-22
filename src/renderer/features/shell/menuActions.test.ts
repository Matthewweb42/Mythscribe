import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import { defaultLayout } from '@shared/layout'
import { DOCS_URL } from '@shared/menu'
import type { UpdateState } from '@shared/updates'
import { EMPTY_DOC } from '@shared/tiptap'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { resetWelcomeStore, useWelcomeStore } from '@renderer/features/project/welcomeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import { resetUpdateStore, useUpdateStore } from '@renderer/features/updates/updateStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { NO_PROJECT_MESSAGE, closeProjectWithConfirm, runMenuAction } from './menuActions'

const info: ProjectInfo = {
  id: '1',
  name: 'Serial',
  format: 'webnovel',
  path: '/tmp/Serial.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

/** F-15.7: what main answers `updates:check` with in these tests. */
const updateState: UpdateState = {
  currentVersion: '0.1.0',
  channel: 'stable',
  autoCheck: true,
  status: { state: 'upToDate', checkedAt: '2026-09-21T10:00:00.000Z' },
  installedNotes: null,
  unseenNotes: false
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(overrides: Partial<Record<string, unknown>> = {}): void {
  invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel in overrides) {
      const v = overrides[channel]
      if (v instanceof Error) throw v
      return v
    }
    if (channel === 'layout:set') return input
    if (channel === 'window:setFullScreen') return input
    if (channel === 'document:get') return { id: (input as { id: string }).id, content: null }
    if (channel === 'document:save') return { wordCount: 1, modified: 'm' }
    if (channel === 'tree:list') return treeFixture
    return null
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function withProject(): Promise<void> {
  useProjectStore.setState({ current: info, ready: true })
  await useTreeStore.getState().load()
}

/** Answers the pending confirm modal. */
function answerConfirm(ok: boolean): void {
  const modal = useDialogStore.getState().modals[0]
  if (modal?.kind !== 'confirm') throw new Error('no confirm modal')
  useDialogStore.getState().resolveConfirm(modal.id, ok)
}

beforeEach(() => {
  install()
  resetPendingSaves()
  resetDocumentStore()
  resetActiveEditorStore()
  resetFocusStore()
  resetLayoutStore()
  resetShellDialogStore()
  resetUpdateStore()
  resetViewStore()
  resetWelcomeStore()
  useProjectStore.setState({ current: null, ready: true, busy: false, recents: [] })
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetDocumentStore()
  resetLayoutStore()
})

describe('runMenuAction (F-7.1)', () => {
  it('toasts and does nothing for a project item with no project open', async () => {
    await runMenuAction('saveDocument')
    await runMenuAction('insertScene')
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE, NO_PROJECT_MESSAGE])
    expect(invoke).not.toHaveBeenCalled()
    expect(useShellDialogStore.getState().open).toBeNull()
  })

  it('opens Settings without a project (F-15.2: the Account tab is app-wide)', async () => {
    await runMenuAction('openSettings')
    expect(toasts()).toEqual([])
    expect(useShellDialogStore.getState().open).toBe('settings')
  })

  it('routes the Edit items through menu:edit', async () => {
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste'] as const) {
      await runMenuAction(role)
      expect(invoke).toHaveBeenLastCalledWith('menu:edit', { role })
    }
  })

  it('opens the documentation through main, and the shell dialogs through their store', async () => {
    await runMenuAction('openDocumentation')
    expect(invoke).toHaveBeenLastCalledWith('menu:openExternal', { url: DOCS_URL })
    await runMenuAction('openShortcuts')
    expect(useShellDialogStore.getState().open).toBe('shortcuts')
    await runMenuAction('openAbout')
    expect(useShellDialogStore.getState().open).toBe('about')
    await withProject()
    await runMenuAction('openSettings')
    expect(useShellDialogStore.getState().open).toBe('settings')
  })

  it('Help › Check for updates… opens the Updates tab and checks (F-15.7)', async () => {
    install({ 'updates:check': updateState })
    await runMenuAction('checkForUpdates')
    expect(useShellDialogStore.getState().open).toBe('settings')
    expect(useShellDialogStore.getState().settingsTab).toBe('updates')
    expect(invoke).toHaveBeenLastCalledWith('updates:check', undefined)
    expect(useUpdateStore.getState().state).toEqual(updateState)
  })

  it('surfaces a failed action as a toast', async () => {
    install({ 'menu:openExternal': new Error('browser missing') })
    await runMenuAction('openDocumentation')
    expect(toasts()).toEqual(['browser missing'])
  })

  it('File › New project shows the wizard; with a project open it asks to close first', async () => {
    await runMenuAction('newProject')
    expect(useWelcomeStore.getState().creating).toBe(true)
    resetWelcomeStore()

    await withProject()
    const pending = runMenuAction('newProject')
    answerConfirm(false)
    await pending
    expect(useWelcomeStore.getState().creating).toBe(false)
    expect(useProjectStore.getState().current).toEqual(info)
    expect(invoke).not.toHaveBeenCalledWith('project:close', undefined)

    const again = runMenuAction('newProject')
    answerConfirm(true)
    await again
    expect(invoke).toHaveBeenCalledWith('project:close', undefined)
    expect(useProjectStore.getState().current).toBeNull()
    expect(useWelcomeStore.getState().creating).toBe(true)
  })

  it('File › Open project… opens through the native dialog and toasts the name', async () => {
    install({ 'project:open': { ...info, name: 'Other' } })
    await runMenuAction('openProject')
    expect(invoke).toHaveBeenCalledWith('project:open', { path: undefined })
    expect(useProjectStore.getState().current?.name).toBe('Other')
    expect(toasts()).toEqual(['Opened "Other"'])
  })

  it('File › Save writes the pending document now', async () => {
    await withProject()
    await useDocumentStore.getState().load('sc-1')
    useDocumentStore.getState().edit('sc-1', EMPTY_DOC)
    await runMenuAction('saveDocument')
    expect(invoke).toHaveBeenCalledWith('document:save', { id: 'sc-1', content: EMPTY_DOC })
  })

  it('File › Close project confirms, then closes', async () => {
    await withProject()
    const pending = runMenuAction('closeProject')
    answerConfirm(true)
    await pending
    expect(invoke).toHaveBeenCalledWith('project:close', undefined)
    expect(useProjectStore.getState().current).toBeNull()
  })

  it('Insert › Scene / Chapter / Arc create relative to the selection, or say what to select', async () => {
    install({
      'tree:create': { ...treeFixture.find((n) => n.id === 'sc-3')!, id: 'new', parentId: 'ch-1' }
    })
    await withProject()
    useTreeStore.getState().select('sc-1')
    await runMenuAction('insertScene')
    expect(invoke).toHaveBeenLastCalledWith('tree:create', {
      parentId: 'ch-1',
      afterId: 'sc-1',
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    await runMenuAction('insertChapter')
    expect(invoke).toHaveBeenLastCalledWith('tree:create', {
      parentId: 'arc-1',
      afterId: 'ch-1',
      kind: 'folder',
      hierarchyLevel: 'chapter'
    })
    useTreeStore.getState().select('title-page')
    await runMenuAction('insertPart')
    expect(toasts()).toEqual(['Select something in the manuscript to insert the arc after it.'])
  })

  it('Insert › Scene break goes into the active editor, or asks for one', async () => {
    await withProject()
    await runMenuAction('insertSceneBreak')
    expect(toasts()).toEqual(['Select a document to insert the scene break into.'])

    const editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '* * *', onSave: vi.fn() }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
      }
    })
    editor.commands.focus('end')
    useActiveEditorStore.getState().set('sc-1', editor)
    await runMenuAction('insertSceneBreak')
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual([
      'paragraph',
      'sceneBreak',
      'paragraph'
    ])
    editor.destroy()
  })

  it('View items toggle the layout panels on the normal screen', async () => {
    await withProject()
    await runMenuAction('toggleSidebar')
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(false)
    await runMenuAction('toggleNotes')
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
    await runMenuAction('toggleAssistant')
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    await runMenuAction('toggleFocusMode')
    expect(invoke).toHaveBeenLastCalledWith('window:setFullScreen', { on: true })
    expect(useFocusStore.getState().active).toBe(true)
  })

  it('View › Zoom in / Zoom out / Reset zoom run without a project and announce the level (F-7.10)', async () => {
    install({ 'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium' } })
    await runMenuAction('zoomIn')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'in' })
    install({ 'view:zoomDocument': { editorZoom: 1, uiScale: 'medium' } })
    await runMenuAction('zoomOut')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'out' })
    await runMenuAction('zoomReset')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'reset' })
    expect(toasts()).toEqual(['Document zoom 110 %', 'Document zoom 100 %', 'Document zoom 100 %'])
    expect(useViewStore.getState().editorZoom).toBe(1)
  })

  it('View › Notes / AI assistant float on the focus flags in focus mode, leaving the layout alone', async () => {
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('toggleNotes')
    await runMenuAction('toggleAssistant')
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: true })
    expect(useLayoutStore.getState().layout).toEqual(defaultLayout())
  })

  it('Tools › Tags opens the sidebar on the Tags tab, leaving focus mode first', async () => {
    await withProject()
    useLayoutStore.getState().toggle('sidebar')
    await useFocusStore.getState().enter()
    await runMenuAction('openTags')
    expect(useFocusStore.getState().active).toBe(false)
    expect(useLayoutStore.getState().layout.sidebar).toMatchObject({ open: true, tab: 'tags' })
  })
})

describe('closeProjectWithConfirm', () => {
  it('answers false when the confirm is refused or the close fails, true when closed', async () => {
    install({ 'project:close': new Error('disk gone') })
    useProjectStore.setState({ current: info })
    const refused = closeProjectWithConfirm()
    answerConfirm(false)
    expect(await refused).toBe(false)
    const failed = closeProjectWithConfirm()
    answerConfirm(true)
    expect(await failed).toBe(false)
    expect(toasts()).toEqual(['disk gone'])
    install()
    const closed = closeProjectWithConfirm()
    answerConfirm(true)
    expect(await closed).toBe(true)
    expect(useProjectStore.getState().current).toBeNull()
  })
})
