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
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetFindStore, useFindStore } from '@renderer/features/editor/findStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { resetGoalsStore, useGoalsStore } from '@renderer/features/goals/goalsStore'
import { draftFixture } from '@renderer/features/import/draftFixture'
import { resetImportStore, useImportStore } from '@renderer/features/import/importStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { resetReplaceStore, useReplaceStore } from '@renderer/features/search/replaceStore'
import { resetSearchStore, useSearchStore } from '@renderer/features/search/searchStore'
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
import {
  NO_DOCUMENT_TO_FIND_MESSAGE,
  NO_PROJECT_MESSAGE,
  closeProjectWithConfirm,
  runMenuAction
} from './menuActions'

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
    if (channel === 'recovery:list') return []
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
  resetEntityStore()
  resetFindStore()
  resetFocusStore()
  resetGoalsStore()
  resetImportStore()
  resetLayoutStore()
  resetSearchStore()
  resetReplaceStore()
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

  it('File › Import manuscript… asks main for a draft and holds it for review (F-12.2)', async () => {
    await withProject()
    install({ 'import:open': draftFixture() })
    await runMenuAction('importManuscript')
    expect(invoke).toHaveBeenCalledWith('import:open', {})
    expect(useImportStore.getState().draft?.source.name).toBe('novel.docx')
    expect(toasts()).toEqual([])
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
    install({ 'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium', pageEdges: true } })
    await runMenuAction('zoomIn')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'in' })
    install({ 'view:zoomDocument': { editorZoom: 1, uiScale: 'medium', pageEdges: true } })
    await runMenuAction('zoomOut')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'out' })
    await runMenuAction('zoomReset')
    expect(invoke).toHaveBeenLastCalledWith('view:zoomDocument', { step: 'reset' })
    expect(toasts()).toEqual(['Document zoom 110 %', 'Document zoom 100 %', 'Document zoom 100 %'])
    expect(useViewStore.getState().editorZoom).toBe(1)
  })

  it('View › Page edges flips the sheet without a project and announces it (F-7.11)', async () => {
    install({ 'view:setPageEdges': { editorZoom: 1, uiScale: 'medium', pageEdges: false } })
    await runMenuAction('togglePageEdges')
    expect(invoke).toHaveBeenLastCalledWith('view:setPageEdges', { on: false })
    expect(useViewStore.getState().pageEdges).toBe(false)
    install({ 'view:setPageEdges': { editorZoom: 1, uiScale: 'medium', pageEdges: true } })
    await runMenuAction('togglePageEdges')
    expect(invoke).toHaveBeenLastCalledWith('view:setPageEdges', { on: true })
    expect(useViewStore.getState().pageEdges).toBe(true)
    expect(toasts()).toEqual(['Page edges hidden', 'Page edges shown'])
  })

  it('View › Notes / AI assistant float on the focus flags in focus mode, leaving the layout alone', async () => {
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('toggleNotes')
    await runMenuAction('toggleAssistant')
    expect(useFocusStore.getState().panels).toEqual({ notes: true, assistant: true })
    expect(useLayoutStore.getState().layout).toEqual(defaultLayout())
  })

  it('Insert › Character / Setting / World-building note open the creation dialog (F-9.3)', async () => {
    await withProject()
    await runMenuAction('insertCharacter')
    expect(useEntityStore.getState().creating).toBe('character')
    await runMenuAction('insertSetting')
    expect(useEntityStore.getState().creating).toBe('setting')

    // The dialog belongs to the project screen, so focus mode is left first.
    await useFocusStore.getState().enter()
    await runMenuAction('insertWorldItem')
    expect(useFocusStore.getState().active).toBe(false)
    expect(useEntityStore.getState().creating).toBe('world')
    expect(toasts()).toEqual([])
  })

  it('Insert › Character with no project open toasts instead (F-9.3)', async () => {
    await runMenuAction('insertCharacter')
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    expect(useEntityStore.getState().creating).toBeNull()
  })

  it('View › References toggles the reference panel, leaving focus mode first (F-9.6)', async () => {
    await withProject()
    await runMenuAction('toggleReferences')
    expect(useLayoutStore.getState().layout.references.open).toBe(true)
    await runMenuAction('toggleReferences')
    expect(useLayoutStore.getState().layout.references.open).toBe(false)
    await useFocusStore.getState().enter()
    await runMenuAction('toggleReferences')
    expect(useFocusStore.getState().active).toBe(false)
    expect(useLayoutStore.getState().layout.references.open).toBe(true)
  })

  it('Edit › Find… / Replace… open the find bar over the active editor, and need one (F-3.10)', async () => {
    await runMenuAction('findInDocument')
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await runMenuAction('findInDocument')
    expect(useFindStore.getState().open).toBe(false)
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE, NO_DOCUMENT_TO_FIND_MESSAGE])
    const editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '* * *', onSave: vi.fn() }),
      content: EMPTY_DOC
    })
    useActiveEditorStore.getState().set('sc-1', editor)
    await runMenuAction('findInDocument')
    expect(useFindStore.getState()).toMatchObject({ open: true, showReplace: false })
    await runMenuAction('replaceInDocument')
    expect(useFindStore.getState()).toMatchObject({ open: true, showReplace: true })
    editor.destroy()
  })

  it('Edit › Search project… opens the search dialog, in focus mode too, and needs a project (F-10.1)', async () => {
    await runMenuAction('searchProject')
    expect(useSearchStore.getState().open).toBe(false)
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('searchProject')
    // A second arrival of the same action (chord and accelerator) leaves it open.
    await runMenuAction('searchProject')
    expect(useSearchStore.getState().open).toBe(true)
    expect(useFocusStore.getState().active).toBe(true)
  })

  it('Edit › Replace in project… opens find and replace in place of the search, and needs a project (F-10.2)', async () => {
    await runMenuAction('replaceProject')
    expect(useReplaceStore.getState().open).toBe(false)
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await runMenuAction('searchProject')
    await runMenuAction('replaceProject')
    // A second arrival of the same action (chord and accelerator) leaves it open.
    await runMenuAction('replaceProject')
    expect(useReplaceStore.getState().open).toBe(true)
    expect(useSearchStore.getState().open).toBe(false)
    await runMenuAction('searchProject')
    expect(useReplaceStore.getState().open).toBe(false)
    expect(useSearchStore.getState().open).toBe(true)
  })

  it('Tools › Tags opens the sidebar on the Tags tab, leaving focus mode first', async () => {
    await withProject()
    useLayoutStore.getState().toggle('sidebar')
    await useFocusStore.getState().enter()
    await runMenuAction('openTags')
    expect(useFocusStore.getState().active).toBe(false)
    expect(useLayoutStore.getState().layout.sidebar).toMatchObject({ open: true, tab: 'tags' })
  })

  it('Tools › Goals… opens the Goals dialog, leaving focus mode first (F-10.3)', async () => {
    await runMenuAction('openGoals')
    expect(useGoalsStore.getState().open).toBe(false)
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openGoals')
    expect(useFocusStore.getState().active).toBe(false)
    expect(useGoalsStore.getState().open).toBe(true)
  })

  it('Tools › Word count… opens the word count dialog, over focus mode too (F-10.4)', async () => {
    await runMenuAction('openWordCount')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openWordCount')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('wordCount')
  })

  it('Tools › Statistics… opens the statistics dialog, over focus mode too (F-10.5)', async () => {
    await runMenuAction('openStatistics')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openStatistics')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('statistics')
  })

  it('View › Compiled preview opens the compiled preview, over focus mode too (F-3.12)', async () => {
    await runMenuAction('openCompile')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openCompile')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('compile')
  })

  it('Tools › Drafts… opens the drafts dialog, over focus mode too (F-8.5)', async () => {
    await runMenuAction('openDrafts')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openDrafts')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('drafts')
  })

  it('Tools › Snapshots… opens the snapshots dialog, over focus mode too (F-8.6)', async () => {
    await runMenuAction('openSnapshots')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('openSnapshots')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('snapshots')
  })

  it('File › Export… opens the export dialog, over focus mode too (F-12.1)', async () => {
    await runMenuAction('exportManuscript')
    expect(useShellDialogStore.getState().open).toBeNull()
    expect(toasts()).toEqual([NO_PROJECT_MESSAGE])
    await withProject()
    await useFocusStore.getState().enter()
    await runMenuAction('exportManuscript')
    expect(useFocusStore.getState().active).toBe(true)
    expect(useShellDialogStore.getState().open).toBe('export')
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
