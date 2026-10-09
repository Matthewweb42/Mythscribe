import { BUILTIN_CATEGORIES } from '@shared/categories'
import { defaultFocusSettings } from '@shared/focus'
import { defaultProjectSession } from '@shared/session'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import { defaultAuthorRules } from '@shared/authorRules'
import type { Conversations } from '@shared/chat'
import type { DraftList } from '@shared/drafts'
import { defaultEditorSettings } from '@shared/editorSettings'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  Output,
  ProjectInfo,
  RecentProject
} from '@shared/ipc/contract'
import { IDLE_INDEX_QUEUE } from '@shared/jobs'
import { defaultDock } from '@shared/dock'
import { defaultFloating, defaultLayout } from '@shared/layout'
import { defaultViewSettings } from '@shared/zoom'
import type { TiptapNodeT } from '@shared/tiptap'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAccountStore, useAccountStore } from '@renderer/features/account/accountStore'
import { resetAppAccessStore } from '@renderer/features/account/appAccessStore'
import { resetBackupStore } from '@renderer/features/backups/backupStore'
import { resetCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { draftFixture } from '@renderer/features/import/draftFixture'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAuthorRulesStore, useAuthorRulesStore } from '@renderer/features/ai/authorRulesStore'
import { resetAssistantStore, useAssistantStore } from '@renderer/features/ai/assistantStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { resetContinuityStore } from '@renderer/features/ai/continuityStore'
import { resetIndexingStore } from '@renderer/features/ai/indexingStore'
import { resetBackgroundStore } from '@renderer/features/focus/backgroundStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { goalsStatusFixture } from '@renderer/features/goals/goalsFixture'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { dialogs, useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetSessionStore } from '@renderer/features/project/sessionStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetReplaceStore, useReplaceStore } from '@renderer/features/search/replaceStore'
import { resetFindStore, useFindStore } from '@renderer/features/editor/findStore'
import { resetSearchStore, useSearchStore } from '@renderer/features/search/searchStore'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityDraftStore } from '@renderer/features/entities/entityDraftStore'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetFactStore } from '@renderer/features/entities/factStore'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetMentionStore } from '@renderer/features/tags/mentionStore'
import { resetProposedTagStore } from '@renderer/features/tags/proposedTagStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { resetWelcomeStore } from '@renderer/features/project/welcomeStore'
import { resetShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { resetDraftStore } from '@renderer/features/drafts/draftStore'
import { resetSnapshotStore } from '@renderer/features/snapshots/snapshotStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import { resetStructureStore } from '@renderer/features/outline/structureStore'
import { resetTimelineStore } from '@renderer/features/timeline/timelineStore'
import { resetCompileWindowStore } from '@renderer/features/compile/compileWindowStore'
import { defaultCompileProjectState } from '@shared/compileFormat'
import { App } from './App'

const info: ProjectInfo = {
  id: '1',
  name: 'Smoke',
  format: 'novel',
  path: '/tmp/Smoke.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

const recent: RecentProject = {
  path: '/tmp/Smoke Novel.mythscribe',
  name: 'Smoke Novel',
  format: 'novel',
  lastOpened: '2026-09-10T12:00:00.000Z',
  exists: true
}

/** Main→renderer event listeners captured by `install()`, keyed by event name. */
/** F-8.5: a project that never used drafts answers its one, active first draft. */
const DRAFTS_ONE: DraftList = {
  drafts: [
    {
      id: 'draft-1',
      name: 'Draft 1',
      wordCount: 0,
      active: true,
      created: '2026-10-04T10:00:00.000Z',
      modified: '2026-10-04T10:00:00.000Z'
    }
  ],
  activeId: 'draft-1'
}

const listeners = new Map<string, (payload: never) => void>()

beforeEach(() => {
  listeners.clear()
  resetPendingSaves()
  useProjectStore.setState({ current: null, ready: false, busy: false, recents: [] })
  useTreeStore.getState().clear()
  useDocumentStore.getState().clear()
  useNotesStore.getState().clear()
  resetLayoutStore()
  resetSessionStore()
  resetEditorSettingsStore()
  resetAiSettingsStore()
  resetAuthorRulesStore()
  resetAssistantStore()
  resetTagStore()
  // F-9.3: the entity page is part of the main pane, so its stores belong to the fixture too.
  resetEntityDraftStore()
  resetEntityStore()
  resetCategoryStore()
  resetFactStore()
  resetChangesStore()
  resetFocusStore()
  resetBackgroundStore()
  resetShellDialogStore()
  resetWelcomeStore()
  resetIndexingStore()
  resetContinuityStore()
  resetAccountStore()
  resetAppAccessStore()
  resetBackupStore()
  resetCloudSyncStore()
  resetViewStore()
  resetStructureStore()
  resetTimelineStore()
  resetCompileWindowStore()
  resetMentionStore()
  resetDocumentTagStore()
  resetProposedTagStore()
  resetSearchStore()
  resetReplaceStore()
  resetGoalsStore()
  resetFindStore()
  resetDraftStore()
  resetSnapshotStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  document.title = ''
  // jsdom has no layout; the drag deltas of the resize handles are divided by this.
  vi.stubGlobal('innerWidth', 1000)
})
afterEach(() => {
  // F-1.7: the session's write is debounced; leaving it pending leaks into the next file.
  resetSessionStore()
  resetDraftStore()
  resetSnapshotStore()
  resetEntityDraftStore()
  resetEntityStore()
  resetCategoryStore()
  resetFactStore()
  resetChangesStore()
  // F-10.1: a search debounce left pending must not fire into the next file's IPC fake.
  resetSearchStore()
  // F-10.2: nor a replace preview's.
  resetReplaceStore()
  // F-10.3: nor a goals refresh after a save.
  resetGoalsStore()
  resetAiSettingsStore()
  resetAuthorRulesStore()
  resetAssistantStore()
  resetBackgroundStore()
  resetIndexingStore()
  resetContinuityStore()
  resetViewStore()
  resetStructureStore()
  resetTimelineStore()
  resetCompileWindowStore()
  resetAppAccessStore()
  vi.unstubAllGlobals()
})

/** The stacked document regions (`<section>`). */
const documentRegions = (): HTMLElement[] =>
  screen.getAllByRole('region').filter((r) => r.tagName === 'SECTION')

function install(overrides: Partial<Record<string, unknown>> = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel in overrides) {
      const v = overrides[channel]
      if (v instanceof Error) throw v
      return v
    }
    if (channel === 'recents:list') return []
    if (channel === 'tree:list') return []
    if (channel === 'tag:list') return []
    if (channel === 'tag:aliases') return {}
    if (channel === 'entity:list') return []
    if (channel === 'category:list') return BUILTIN_CATEGORIES
    if (channel === 'fact:listForEntity') return []
    if (channel === 'changes:list') return { entries: [], more: false }
    if (channel === 'documentTag:list') return []
    if (channel === 'tag:proposed') return []
    if (channel === 'tag:dismissedNames') return []
    if (channel === 'sceneMeta:get')
      return { id: (input as { id: string }).id, meta: { location: '', pov: '', timeline: '' } }
    if (channel === 'document:get') return { id: (input as { id: string }).id, content: null }
    if (channel === 'notes:get') return { id: (input as { id: string }).id, notes: null }
    if (channel === 'editorSettings:get') return defaultEditorSettings('novel')
    if (channel === 'aiSettings:get') return defaultAiSettings()
    if (channel === 'authorRules:get') return defaultAuthorRules()
    if (channel === 'layout:get') return defaultLayout()
    if (channel === 'layout:set') return input
    if (channel === 'session:get') return defaultProjectSession()
    if (channel === 'session:set') return input
    if (channel === 'window:setFullScreen') return input // the fake window does what it is asked
    if (channel === 'conversations:get') return { active: null, items: [] }
    if (channel === 'focusSettings:get') return { ...defaultFocusSettings(), backgroundId: null }
    if (channel === 'background:list') return []
    if (channel === 'dictionary:get') return { words: [], notNames: [] }
    if (channel === 'reference:get') return { pins: [] }
    if (channel === 'goals:get') return goalsStatusFixture()
    if (channel === 'jobs:status') return IDLE_INDEX_QUEUE
    if (channel === 'continuity:list') return []
    if (channel === 'editPass:list') return []
    if (channel === 'editPass:presets') return []
    if (channel === 'editPass:changes') return []
    if (channel === 'view:get') return defaultViewSettings()
    if (channel === 'startup:get') return { reopenLastProject: true }
    if (channel === 'recovery:list') return []
    if (channel === 'drafts:list') return DRAFTS_ONE
    if (channel === 'snapshots:list') return []
    if (channel === 'structure:get') return { template: null }
    if (channel === 'timeline:get') return { events: [] }
    if (channel === 'library:list') return []
    if (channel === 'compileState:get') return defaultCompileProjectState()
    if (channel === 'compileFormat:list') return []
    return null
  })
  const on = <E extends EventName>(
    event: E,
    listener: (payload: EventPayload<E>) => void
  ): (() => void) => {
    listeners.set(event, listener)
    return () => {
      listeners.delete(event)
    }
  }
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on
  }
  setIpcClient(client)
  return invoke
}

/** Delivers a main→renderer event to the listener the app registered for it. */
function fire<E extends EventName>(event: E, payload: EventPayload<E>): void {
  const listener = listeners.get(event)
  if (!listener) throw new Error(`No listener registered for ${event}`)
  act(() => listener(payload as never))
}

/** Use AI off unless `dial` says otherwise, so a test that is not about F-5.18 keeps the panel closed. */
async function fillWizard(
  name: string,
  format: RegExp,
  source?: RegExp,
  dial = /^off/i
): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
  await userEvent.type(await screen.findByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('radio', { name: format }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  if (source) await userEvent.click(await screen.findByRole('radio', { name: source }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('radio', { name: dial }))
  // F-9.8: the optional worldbuilding step, skipped.
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
}

const createdScene = {
  id: 'new-sc',
  parentId: 'ch-1',
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title: 'Untitled Scene',
  position: 1,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm'
} as const

/** The dock column holding the sidebar (layout 3c): it carries the width and the resize handle. */
const sidebarColumn = (): HTMLElement => {
  const column = screen
    .getByRole('complementary')
    .closest<HTMLElement>('[data-testid="dock-column"]')
  if (!column) throw new Error('the sidebar is not in a dock column')
  return column
}

/** Picks a sidebar section through the section picker (F-9.11). */
async function showSection(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /^Section: / }))
  await userEvent.click(
    within(screen.getByRole('listbox', { name: 'Sections' })).getByRole('option', { name })
  )
}

describe('App', () => {
  it('shows the welcome screen, creates a project through the wizard, then closes it', async () => {
    const invoke = install({ 'project:create': { ...info, format: 'epic' } })
    render(<App />)
    await fillWizard('Smoke', /^epic/i, /^local model/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    // F-15.11, F-5.18: the wizard's AI steps travel with the create, so main stores them with the project.
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'epic',
      directory: undefined,
      aiSource: 'local',
      aiSwitch: 'off'
    })
    // At Off the assistant panel stays as it was.
    expect(useLayoutStore.getState().layout.assistant.open).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('Created "Smoke"')

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    expect(await screen.findByRole('button', { name: /new project/i })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('project:close', undefined)
  })

  it('shows the project name and format in the shell header, window title, and tree (F-1.5, F-2.1)', async () => {
    install({
      'project:create': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'tag:list': tagFixture
    })
    render(<App />)
    await fillWizard('Serial', /^web novel/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Serial')
    expect(screen.getByRole('banner')).toHaveTextContent('Serial · Web novel')
    expect(screen.getByRole('banner')).not.toHaveTextContent('MythScribe')
    expect(document.title).toBe(`MythScribe — ${info.path}`)
    // The tree labels the manuscript section by format and starts with nothing selected.
    expect(await screen.findByRole('treeitem', { name: 'Volume 1' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: 'Arc 1' })).toBeInTheDocument()
    // F-2.2: the create buttons sit under the tree in the sidebar, labelled by format.
    const aside = screen.getByRole('complementary')
    expect(within(aside).getByRole('tree')).toBeInTheDocument()
    const bar = within(aside).getByRole('button', { name: 'New arc' })
    expect(bar).toBeInTheDocument()
    expect(within(aside).getByRole('tree').compareDocumentPosition(bar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    // F-3.5: the empty state fills the pane until something is selected.
    expect(screen.getByTestId('empty-state')).toHaveTextContent(
      'Select a document to start writing.'
    )
    expect(screen.queryByTestId('selected-title')).not.toBeInTheDocument()
    // F-4.2: the tag bank loads with the project. F-9.11: the section picker lists the sections in
    // use by name — Manuscript, the categories with sheets (Characters and Places always), then
    // the tools — and keeps the empty ones behind "Show unused sections".
    await waitFor(() => expect(useTagStore.getState().loaded).toBe(true))
    expect(useTagStore.getState().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    const picker = within(aside).getByRole('button', { name: 'Section: Manuscript' })
    await userEvent.click(picker)
    const listbox = within(aside).getByRole('listbox', { name: 'Sections' })
    const names = (): string[] =>
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label') ?? o.textContent ?? '')
    expect(names()).toEqual([
      'Manuscript',
      'Characters',
      'Places',
      'Tags',
      'Outline',
      'Show unused sections (15)',
      'New category…'
    ])
    await userEvent.click(within(listbox).getByRole('option', { name: /^Show unused sections/ }))
    expect(names()).toContain('Magic Systems')
    expect(names()).toContain('Library')
    await userEvent.keyboard('{Escape}')
    expect(within(aside).queryByRole('listbox')).not.toBeInTheDocument()
    expect(picker).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(document.title).toBe('MythScribe')
    // The welcome screen's bar is minimal: no menu bar, no project segment, Settings at the right.
    expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: /settings/i })
    ).toBeInTheDocument()
    // Closing the project clears the tree store.
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
    expect(useTreeStore.getState().rootIds).toEqual([])
    expect(useTreeStore.getState().loaded).toBe(false)
    // F-4.2: and the tag store.
    expect(useTagStore.getState().ids).toEqual([])
    expect(useTagStore.getState().loaded).toBe(false)
  })

  it('selecting a document in the tree shows it in the main pane (F-2.1)', async () => {
    const invoke = install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture
    })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    expect(invoke).toHaveBeenCalledWith('tree:list', undefined)
    await userEvent.click(within(scene).getByText('Scene 1'))
    expect(scene).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Scene 1')
    expect(screen.getByText('(Scene · Volume 1)', { exact: false })).toBeInTheDocument()
    // F-3.1: a document mounts the editor and its toolbar, loaded through document:get.
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    const box = await screen.findByRole('textbox', { name: 'Document' })
    expect(invoke).toHaveBeenCalledWith('document:get', { id: 'sc-1' })
    await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'true'))

    await userEvent.click(
      within(screen.getByRole('treeitem', { name: 'Arc 2' })).getByText('Arc 2')
    )
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Arc 2')
    expect(screen.getByText('(Arc · Volume 1)', { exact: false })).toBeInTheDocument()
    // F-2.5/F-3.8: a folder stacks every descendant document in tree order under one toolbar,
    // each loaded under its own id; the single document was unloaded with its pane.
    expect(documentRegions().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Scene 4',
      'Scene 5',
      'Scene 6'
    ])
    expect(screen.getAllByRole('toolbar', { name: 'Formatting' })).toHaveLength(1)
    expect(screen.getAllByRole('textbox', { name: 'Document' })).toHaveLength(3)
    expect(screen.getAllByRole('separator', { name: 'Scene break' })).toHaveLength(2)
    for (const id of ['sc-4', 'sc-5', 'sc-6']) {
      expect(invoke).toHaveBeenCalledWith('document:get', { id })
    }
    await waitFor(() =>
      expect(Object.keys(useDocumentStore.getState().docs).sort()).toEqual(['sc-4', 'sc-5', 'sc-6'])
    )
  })

  it('an entity picked in its tab takes the main pane, and the tree takes it back (F-9.3)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'entity:list': entityFixture
    })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    await userEvent.click(within(scene).getByText('Scene 1'))
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Scene 1')

    await showSection('Characters')
    await userEvent.click(await screen.findByRole('button', { name: /^Mara/ }))
    // The page replaces the title block, the editor, and the notes panel.
    expect(screen.getByRole('article', { name: 'Mara' })).toBeInTheDocument()
    expect(screen.queryByTestId('selected-title')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Document' })).not.toBeInTheDocument()

    // Back to the manuscript: the tree selection was never touched.
    await showSection('Manuscript')
    await userEvent.click(
      within(screen.getByRole('treeitem', { name: 'Scene 1' })).getByText('Scene 1')
    )
    expect(screen.queryByRole('article', { name: 'Mara' })).not.toBeInTheDocument()
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Scene 1')
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('invites the author to add a scene to an empty chapter (F-3.8)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture.filter((n) => n.id !== 'sc-1')
    })
    render(<App />)
    const chapter = await screen.findByRole('treeitem', { name: 'Chapter 1' })
    await userEvent.click(within(chapter).getByText('Chapter 1'))
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Chapter 1')
    expect(screen.getByText('Nothing here yet. Add a scene to start writing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a scene' })).toBeInTheDocument()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Document' })).not.toBeInTheDocument()
  })

  it('stays on the folder after adding a scene from its empty-folder invitation (F-3.8)', async () => {
    const invoke = install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture.filter((n) => n.id !== 'sc-1'),
      'tree:create': {
        id: 'new-sc',
        parentId: 'ch-1',
        sectionType: null,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: 'Untitled Scene',
        position: 0,
        wordCount: 0,
        matterType: null,
        preset: null,
        created: 'c',
        modified: 'm'
      }
    })
    render(<App />)
    const chapter = await screen.findByRole('treeitem', { name: 'Chapter 1' })
    await userEvent.click(within(chapter).getByText('Chapter 1'))
    await userEvent.click(screen.getByRole('button', { name: 'Add a scene' }))
    expect(invoke).toHaveBeenCalledWith('tree:create', {
      parentId: 'ch-1',
      afterId: undefined,
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    // The plan (S4+S5) calls for the new region to mount inside the still-visible stack for the
    // selected folder; instead `createAt` (treeStore.ts) selects the new document, so `MainPane`
    // swaps the whole pane to a single-document `EditorPane` and the Chapter 1 stack disappears.
    await waitFor(() => expect(screen.getByTestId('selected-title')).toHaveTextContent('Chapter 1'))
    expect(documentRegions().map((r) => r.getAttribute('aria-label'))).toEqual(['Untitled Scene'])
  })

  it('shows the stored document in the editor and drops it when the project closes (F-3.1)', async () => {
    const hello: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Once upon a ' },
            { type: 'text', text: 'time', marks: [{ type: 'bold' }] }
          ]
        }
      ]
    }
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'document:get': { id: 'sc-1', content: hello }
    })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    await userEvent.click(within(scene).getByText('Scene 1'))
    const box = await screen.findByRole('textbox', { name: 'Document' })
    await waitFor(() => expect(box).toHaveTextContent('Once upon a time'))
    expect(box.querySelector('strong')).toHaveTextContent('time')
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useDocumentStore.getState().docs).toEqual({})
  })

  it('shows the notes panel beside a folder stack when Notes is open, and clears the notes on close (F-3.7)', async () => {
    const chapterNotes: TiptapNodeT = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Get them to the coast' }] }]
    }
    const invoke = install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'notes:get': { id: 'ch-1', notes: chapterNotes }
    })
    render(<App />)
    const chapter = await screen.findByRole('treeitem', { name: 'Chapter 1' })
    await userEvent.click(within(chapter).getByText('Chapter 1'))
    expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
    // The stack's shared toolbar carries the toggle next to the formatting settings.
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    const toggle = within(toolbar).getByRole('button', { name: 'Notes' })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const panel = screen.getByTestId('notes-panel')
    expect(invoke).toHaveBeenCalledWith('notes:get', { id: 'ch-1' })
    const notes = await within(panel).findByRole('textbox', { name: 'Notes' })
    await waitFor(() => expect(notes).toHaveTextContent('Get them to the coast'))
    // Beside the stack, not among its regions: the regions are still the chapter's scenes.
    expect(documentRegions().map((r) => r.getAttribute('aria-label'))).toEqual(['Scene 1'])
    expect(toolbar.compareDocumentPosition(panel)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(Object.keys(useNotesStore.getState().docs)).toEqual(['ch-1'])

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useNotesStore.getState().docs).toEqual({})
    // The panel's open state is app-wide (F-7.2), so it is still open for the next project.
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
  })

  it('loads the layout at start and sizes the sidebar from it in vw (F-7.2)', async () => {
    const invoke = install({
      'project:current': info,
      'layout:get': {
        sidebar: { open: true, size: 0.3, tab: 'manuscript' },
        notes: { open: false, size: 0.25 },
        tags: { open: false, size: 0.2 },
        assistant: { open: false, size: 0.3 },
        references: { open: false, size: 0.22 },
        floating: defaultFloating(),
        dock: { columns: defaultDock() }
      }
    })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).toHaveBeenCalledWith('layout:get', undefined)
    await waitFor(() => expect(useLayoutStore.getState().layout.sidebar.size).toBe(0.3))
    // The width and the handle are the dock column's (layout 3c), around the sidebar.
    const aside = sidebarColumn()
    expect(aside.style.width).toBe('30vw')
    const handle = within(aside).getByRole('separator', { name: 'Resize sidebar' })
    expect(handle).toHaveAttribute('aria-valuenow', '30')
    expect(handle).toHaveAttribute('aria-valuemin', '15')
    expect(handle).toHaveAttribute('aria-valuemax', '35')
  })

  it('the sidebar handle resizes it by drag and by arrow keys, and the size is written (F-7.2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      await screen.findByRole('treeitem', { name: 'Volume 1' })
      const aside = sidebarColumn()
      expect(aside.style.width).toBe('22vw')
      const handle = within(aside).getByRole('separator', { name: 'Resize sidebar' })
      handle.focus()
      await userEvent.keyboard('{ArrowRight}')
      // 16 px of a 1000 px window: 0.22 → 0.236.
      expect(useLayoutStore.getState().layout.sidebar.size).toBeCloseTo(0.236)
      expect(aside.style.width).toBe(`${0.236 * 100}vw`)
      expect(handle).toHaveAttribute('aria-valuenow', '24')
      fireEvent.pointerDown(handle, { clientX: 236, button: 0 })
      fireEvent.pointerMove(window, { clientX: 300 })
      fireEvent.pointerUp(window, { clientX: 300 })
      expect(useLayoutStore.getState().layout.sidebar.size).toBeCloseTo(0.3)
      expect(aside.style.width).toBe(`${useLayoutStore.getState().layout.sidebar.size * 100}vw`)
      await act(() => vi.advanceTimersByTimeAsync(200))
      const writes = invoke.mock.calls.filter(([c]) => c === 'layout:set')
      expect(writes).toHaveLength(1)
      expect(writes[0]?.[1]).toEqual({
        sidebar: {
          open: true,
          size: useLayoutStore.getState().layout.sidebar.size,
          tab: 'manuscript'
        },
        notes: { open: false, size: 0.25 },
        tags: { open: false, size: 0.2 },
        assistant: { open: false, size: 0.3 },
        references: { open: false, size: 0.22 },
        floating: defaultFloating(),
        dock: { columns: defaultDock() }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the header button hides and shows the sidebar (F-7.2)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Volume 1' })
    const toggle = screen.getByRole('button', { name: 'Sidebar' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).not.toBeInTheDocument()
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(false)
    // The main pane is still there for the author.
    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(sidebarColumn().style.width).toBe('22vw')
  })

  it('does not show the sidebar button on the welcome screen', async () => {
    install()
    render(<App />)
    await screen.findByRole('button', { name: /new project/i })
    expect(screen.queryByRole('button', { name: 'Sidebar' })).not.toBeInTheDocument()
  })

  it('loads the formatting settings with the project, applies them to the editor, and drops them on close (F-3.6)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'editorSettings:get': { ...defaultEditorSettings('webnovel'), fontSize: 20, maxWidth: 900 }
    })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    await waitFor(() => expect(useEditorSettingsStore.getState().settings?.fontSize).toBe(20))
    await userEvent.click(within(scene).getByText('Scene 1'))
    const pane = (await screen.findByRole('toolbar', { name: 'Formatting' })).parentElement
    expect(pane?.style.getPropertyValue('--ms-editor-font-size')).toBe('20px')
    expect(pane?.style.getPropertyValue('--ms-editor-max-width')).toBe('900px')

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useEditorSettingsStore.getState().settings).toBeNull()
  })

  it('loads the AI dial with the project and drops it on close (F-14.4)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'aiSettings:get': { ...defaultAiSettings(), dial: 1 }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    await waitFor(() => expect(useAiSettingsStore.getState().settings?.dial).toBe(1))
    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useAiSettingsStore.getState().settings).toBeNull()
  })

  it('loads the author rules with the project and drops them on close (F-14.2)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'authorRules:get': { rules: 'British spelling.', bannedPhrases: ['delve'] }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    await waitFor(() =>
      expect(useAuthorRulesStore.getState().settings?.bannedPhrases).toEqual(['delve'])
    )
    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useAuthorRulesStore.getState().settings).toBeNull()
  })

  it('opens the Settings dialog from the header button and shows the Editor tab (F-7.5)', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'editorSettings:get': { ...defaultEditorSettings('webnovel'), fontSize: 20 }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    await waitFor(() => expect(useEditorSettingsStore.getState().settings?.fontSize).toBe(20))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(within(dialog).getByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(within(dialog).getByRole('spinbutton', { name: 'Font size' })).toHaveValue(20)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the Settings dialog with Ctrl+, when a project is open (F-7.5)', async () => {
    install({ 'project:current': info, 'tree:list': treeFixture })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    await userEvent.keyboard('{Control>},{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(dialog).getByRole('spinbutton', { name: 'Font size' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Ctrl+Shift+F and the header button open the project search, which searches and closes with the project (F-10.1)', async () => {
    const invoke = install({
      'project:current': info,
      'tree:list': treeFixture,
      'search:query': {
        results: [
          {
            type: 'document',
            id: 'sc-2',
            title: 'Scene 2',
            location: 'Chapter 2',
            field: null,
            snippet: { text: 'The lantern swung.', highlights: [[4, 11]] },
            titleHighlights: [],
            count: 1
          }
        ],
        total: 1,
        truncated: false
      }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    expect(screen.queryByRole('dialog', { name: 'Search project' })).not.toBeInTheDocument()

    await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Search project' })
    const box = within(dialog).getByRole('searchbox', { name: 'Search the project' })
    expect(box).toHaveFocus()
    await userEvent.type(box, 'lantern')
    const row = await within(dialog).findByRole('option', { name: /Scene 2/ })
    expect(invoke).toHaveBeenCalledWith('search:query', {
      query: 'lantern',
      types: ['document', 'notes', 'character', 'setting', 'world'],
      tagId: null
    })
    expect(row.querySelector('mark')).toHaveTextContent('lantern')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Search project' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Search project' }))
    expect(await screen.findByRole('dialog', { name: 'Search project' })).toBeInTheDocument()
    expect(useSearchStore.getState().query).toBe('lantern')
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useSearchStore.getState()).toMatchObject({ open: false, query: '', response: null })
    expect(screen.queryByRole('button', { name: 'Search project' })).not.toBeInTheDocument()
    // No project: the chord does nothing.
    await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')
    expect(useSearchStore.getState().open).toBe(false)
  })

  it('Ctrl+Shift+H opens find and replace on the selection, in place of the search, and it closes with the project (F-10.2)', async () => {
    const invoke = install({
      'project:current': info,
      'tree:list': treeFixture,
      'replace:preview': {
        items: [
          {
            id: 'sc-2',
            title: 'Scene 2',
            location: 'Chapter 2',
            count: 1,
            samples: [
              {
                before: { text: 'The lantern swung.', range: [4, 11] },
                after: { text: 'The lamp swung.', range: [4, 8] }
              }
            ]
          }
        ],
        total: 1,
        truncated: false
      }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    expect(screen.queryByRole('dialog', { name: 'Replace in project' })).not.toBeInTheDocument()

    await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')
    await screen.findByRole('dialog', { name: 'Search project' })
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Replace in project' })
    expect(screen.queryByRole('dialog', { name: 'Search project' })).not.toBeInTheDocument()
    const find = within(dialog).getByRole('textbox', { name: 'Find' })
    expect(find).toHaveFocus()
    await userEvent.type(find, 'lantern')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Replace with' }), 'lamp')
    const group = await within(dialog).findByTestId('replace-document')
    expect(group).toHaveTextContent('Scene 2')
    expect(group.querySelector('del')).toHaveTextContent('lantern')
    expect(group.querySelector('ins')).toHaveTextContent('lamp')
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('replace:preview', {
        query: 'lantern',
        replacement: 'lamp',
        matchCase: false,
        wholeWord: false,
        scopeId: null
      })
    )
    expect(invoke).not.toHaveBeenCalledWith('replace:commit', expect.anything())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Replace in project' })).not.toBeInTheDocument()

    // The search dialog's Replace… hands its query over.
    await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')
    const search = await screen.findByRole('dialog', { name: 'Search project' })
    await userEvent.click(within(search).getByRole('button', { name: 'Replace…' }))
    expect(await screen.findByRole('dialog', { name: 'Replace in project' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Search project' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useReplaceStore.getState()).toMatchObject({ open: false, query: '', preview: null })
    // No project: the chord does nothing.
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}')
    expect(useReplaceStore.getState().open).toBe(false)
  })

  it('Ctrl+F and Ctrl+H open the find bar over the open document, and it closes with the project (F-3.10)', async () => {
    install({ 'project:current': info, 'tree:list': treeFixture })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    // No document open yet: the chord says so and opens nothing.
    await userEvent.keyboard('{Control>}f{/Control}')
    expect(useFindStore.getState().open).toBe(false)
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toContain(
      'Open a document first.'
    )

    await userEvent.click(within(scene).getByText('Scene 1'))
    const box = await screen.findByRole('textbox', { name: 'Document' })
    await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'true'))
    await userEvent.keyboard('{Control>}f{/Control}')
    const bar = await screen.findByRole('search', { name: 'Find in document' })
    expect(within(bar).getByRole('textbox', { name: 'Find' })).toHaveFocus()
    expect(within(bar).queryByRole('textbox', { name: 'Replace with' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Control>}h{/Control}')
    expect(within(bar).getByRole('textbox', { name: 'Replace with' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('search', { name: 'Find in document' })).not.toBeInTheDocument()

    await userEvent.keyboard('{Control>}f{/Control}')
    await userEvent.type(screen.getByRole('textbox', { name: 'Find' }), 'lantern')
    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useFindStore.getState()).toMatchObject({ open: false, query: '' })
  })

  it('a project created with AI on opens in the assistant panel, chat in Ask, no actions menu (F-5.18, 2026-10-07)', async () => {
    const invoke = install({
      'project:create': info,
      'tree:list': treeFixture,
      'aiSettings:get': { ...defaultAiSettings(), dial: 1 }
    })
    render(<App />)
    await fillWizard('Smoke', /^novel/i, undefined, /^on/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'novel',
      directory: undefined,
      aiSource: 'ownKey',
      aiSwitch: 'ask'
    })
    const panel = await screen.findByRole('complementary', { name: 'Assistant' })
    const modes = await within(panel).findByRole('radiogroup', { name: 'Mode' })
    expect(
      within(modes)
        .getAllByRole('radio')
        .map((r) => r.textContent)
    ).toEqual(['Auto', 'Ask', 'Plan'])
    expect(within(modes).getByRole('radio', { name: 'Ask' })).toBeChecked()
    expect(within(panel).queryByRole('button', { name: 'AI actions' })).not.toBeInTheDocument()
    expect(within(panel).getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('Ctrl+K opens the assistant panel beside the main pane; the conversations load with the project and drop on close (F-5.4)', async () => {
    const stored: Conversations = {
      active: 'c-1',
      items: [
        {
          id: 'c-1',
          title: 'Why the ridge?',
          mode: 'plan',
          paragraphs: 1,
          messages: [],
          created: '2026-09-15T10:00:00.000Z',
          modified: '2026-09-15T10:00:00.000Z'
        }
      ]
    }
    const invoke = install({
      'project:current': info,
      'tree:list': treeFixture,
      'conversations:get': stored
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    expect(invoke).toHaveBeenCalledWith('conversations:get', undefined)
    await waitFor(() => expect(useAssistantStore.getState().conversations).toEqual(stored))
    const toggle = screen.getByRole('button', { name: 'Assistant' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const panel = screen.getByRole('complementary', { name: 'Assistant' })
    expect(panel.closest<HTMLElement>('[data-testid="dock-column"]')?.style.width).toBe('30vw')
    expect(within(panel).getByRole('tab', { name: 'Why the ridge?' })).toBeInTheDocument()
    // Docked at the right edge: after the main pane, full height.
    expect(
      screen.getByTestId('empty-state').compareDocumentPosition(panel) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(useAssistantStore.getState().conversations).toBeNull()
    expect(screen.queryByRole('button', { name: 'Assistant' })).not.toBeInTheDocument()
    // The panel's open state is app-wide (F-7.2), so it is still open for the next project.
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('opens Settings on the welcome screen with only the app-wide tabs (F-7.5, F-15.2, F-15.7, F-15.8, F-7.10, F-8.4)', async () => {
    install()
    render(<App />)
    await screen.findByRole('button', { name: /new project/i })
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    await userEvent.keyboard('{Control>},{/Control}')
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Backups', 'Appearance', 'Account', 'Updates', 'Diagnostics', 'Advanced'])
    // The dialog opens on the first app-wide tab, so Account's text is a tab click away.
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Account' }))
    expect(
      within(dialog).getByText('Optional. You never need an account to write.', { exact: false })
    ).toBeInTheDocument()
  })

  it('surfaces a failed document load as a toast and keeps the editor read-only', async () => {
    install({
      'project:current': { ...info, name: 'Serial', format: 'webnovel' },
      'tree:list': treeFixture,
      'document:get': new Error('Stored document content is not valid JSON')
    })
    render(<App />)
    const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
    await userEvent.click(within(scene).getByText('Scene 1'))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Stored document content is not valid JSON'
    )
    expect(screen.getByRole('textbox', { name: 'Document' })).toHaveAttribute(
      'contenteditable',
      'false'
    )
  })

  it('surfaces a failed tree load as a toast', async () => {
    install({ 'project:current': info, 'tree:list': new Error('Database is locked') })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(await screen.findByRole('status')).toHaveTextContent('Database is locked')
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
  })

  it('Cancel in the close confirmation keeps the project open', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).not.toHaveBeenCalledWith('project:close', undefined)
  })

  it('shows create errors inline in the wizard and keeps it open', async () => {
    install({ 'project:create': new Error('Folder is not empty: /x') })
    render(<App />)
    await fillWizard('Smoke', /^novel/i)
    const wizard = screen.getByRole('dialog', { name: 'Have worldbuilding docs? Add them' })
    expect(await within(wizard).findByRole('alert')).toHaveTextContent('Folder is not empty: /x')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('keeps the wizard open without a toast when the save dialog is cancelled', async () => {
    const invoke = install({ 'project:create': null })
    render(<App />)
    await fillWizard('Smoke', /^novel/i)
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'novel',
      directory: undefined,
      aiSource: 'ownKey',
      aiSwitch: 'off'
    })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(
      screen.getByRole('dialog', { name: 'Have worldbuilding docs? Add them' })
    ).toBeInTheDocument()
  })

  it('Cancel in the wizard returns to the welcome buttons', async () => {
    install()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await screen.findByRole('dialog', { name: 'New project' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  it('imports a manuscript to start a project: the review names the project (F-12.2)', async () => {
    const invoke = install({ 'import:open': draftFixture() })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /import manuscript/i }))
    expect(invoke).toHaveBeenCalledWith('import:open', {})
    const review = await screen.findByTestId('import-dialog')
    expect(within(review).getByRole('textbox', { name: 'Project name' })).toHaveValue('novel')
    expect(within(review).getByTestId('import-commit')).toHaveTextContent('Create project')
    // Cancel writes nothing and leaves the welcome screen as it was.
    await userEvent.click(within(review).getByTestId('import-cancel'))
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('import:createProject', expect.anything())
  })

  it('surfaces open errors as toasts', async () => {
    install({ 'project:open': new Error('No MythScribe project at /x') })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /open project/i }))
    expect(await screen.findByRole('status')).toHaveTextContent('No MythScribe project at /x')
  })

  it('shows the logo and opens a recent project from the list', async () => {
    const invoke = install({
      'recents:list': [recent],
      'project:open': { ...info, name: 'Smoke Novel', path: recent.path }
    })
    render(<App />)
    expect(await screen.findByRole('img', { name: 'MythScribe' })).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Smoke Novel' }))
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke Novel')
    expect(invoke).toHaveBeenCalledWith('project:open', { path: recent.path })
    expect(screen.getByRole('status')).toHaveTextContent('Opened "Smoke Novel"')
  })

  it('surfaces a failed recent open as a toast and refreshes the list', async () => {
    const invoke = install({
      'recents:list': [recent],
      'project:open': new IpcRequestError({
        code: 'NOT_FOUND',
        message: 'No MythScribe project at /x'
      })
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Smoke Novel' }))
    expect(await screen.findByRole('status')).toHaveTextContent('No MythScribe project at /x')
    const listCalls = invoke.mock.calls.filter(([c]) => c === 'recents:list')
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('button', { name: 'Smoke Novel' })).toBeInTheDocument()
  })

  it('removes a recent project from the list', async () => {
    const invoke = install({ 'recents:list': [recent], 'recents:remove': [] })
    render(<App />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Smoke Novel from recent projects' })
    )
    expect(invoke).toHaveBeenCalledWith('recents:remove', { path: recent.path })
    expect(screen.queryByRole('button', { name: 'Smoke Novel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Recent projects' })).not.toBeInTheDocument()
  })

  it('flushes pending saves and closes the window when the OS asks to close it', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    const flush = vi.fn(async () => {})
    registerPendingSave(flush)
    fire('window:close-requested', null)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('window:close', undefined))
    expect(flush).toHaveBeenCalledTimes(1)
    const closeCall = invoke.mock.calls.findIndex(([c]) => c === 'window:close')
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[closeCall] ?? -1
    )
  })

  it('keeps the window open with an error toast when a pending save fails', async () => {
    const invoke = install({ 'project:current': info })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    registerPendingSave(async () => {
      throw new Error('Could not save Chapter 1')
    })
    fire('window:close-requested', null)
    expect(await screen.findByRole('status')).toHaveTextContent('Could not save Chapter 1')
    expect(invoke).not.toHaveBeenCalledWith('window:close', undefined)
    expect(screen.getByTestId('project-name')).toHaveTextContent('Smoke')
  })

  describe('focus mode (F-6.1)', () => {
    const asides = (): HTMLElement[] => screen.queryAllByRole('complementary')
    /** What was asked of the window, in order (leaving fullscreen remounts the tags column, whose own calls follow). */
    const fullScreenCalls = (invoke: ReturnType<typeof vi.fn>): unknown[] =>
      invoke.mock.calls
        .filter(([c]) => c === 'window:setFullScreen')
        .map(([, input]: unknown[]): unknown => input)

    it('F11 enters OS fullscreen and hides the chrome; Escape leaves it with the layout intact', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'))
      // The tags column starts closed; the header's Tags button opens it beside the editor.
      await userEvent.click(
        within(screen.getByRole('banner')).getByRole('button', { name: 'Tags' })
      )
      expect(screen.getByRole('region', { name: 'Tags' })).toBeInTheDocument()
      editor.focus()

      await userEvent.keyboard('{F11}')
      expect(invoke).toHaveBeenLastCalledWith('window:setFullScreen', { on: true })
      await waitFor(() => expect(useFocusStore.getState().active).toBe(true))
      expect(screen.queryByRole('banner')).not.toBeInTheDocument()
      expect(asides()).toEqual([])
      expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Tags' })).not.toBeInTheDocument()
      // The editor and its status bar stay; the layout store did not move.
      expect(screen.getByRole('textbox', { name: 'Document' })).toHaveAttribute(
        'contenteditable',
        'true'
      )
      expect(screen.getByTestId('status-words')).toBeInTheDocument()
      expect(useLayoutStore.getState().layout.sidebar.open).toBe(true)

      // The caret is in the editor, where ProseMirror claims every Escape: the editor's own
      // binding hands the bare one on, and the document listener sees it as claimed (one call).
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Document' }))
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
        keyCode: 27
      })
      expect(fullScreenCalls(invoke)).toEqual([{ on: true }, { on: false }])
      await waitFor(() => expect(useFocusStore.getState().active).toBe(false))
      expect(screen.getByRole('banner')).toBeInTheDocument()
      // The sidebar and the tags column are back.
      expect(asides()).toHaveLength(2)
      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Tags' })).toBeInTheDocument()
      expect(screen.getByRole('treeitem', { name: 'Scene 1' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      // Escape while windowed asks nothing.
      await userEvent.keyboard('{Escape}')
      expect(fullScreenCalls(invoke)).toHaveLength(2)
    })

    it('shows the selected background behind the editor only in focus mode (F-6.2)', async () => {
      const url = 'mythscribe-asset://backgrounds/b1.png'
      install({
        'project:current': info,
        'tree:list': treeFixture,
        'focusSettings:get': { ...defaultFocusSettings(), backgroundId: 'b1' },
        'background:list': [{ id: 'b1', name: 'b1.png', url }]
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'))
      expect(screen.queryByTestId('focus-backdrop')).not.toBeInTheDocument()
      expect(editor.parentElement).not.toHaveClass('focus-surface')

      editor.focus()
      await userEvent.keyboard('{F11}')
      await waitFor(() => expect(useFocusStore.getState().active).toBe(true))
      const backdrop = await screen.findByTestId('focus-backdrop')
      expect(backdrop).toHaveStyle({ backgroundImage: `url("${url}")` })
      expect(screen.getByRole('main')).toHaveClass('isolate')
      // The column gets its translucent panel over the image.
      expect(screen.getByRole('textbox', { name: 'Document' }).parentElement).toHaveClass(
        'focus-surface'
      )

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', keyCode: 27 })
      await waitFor(() => expect(useFocusStore.getState().active).toBe(false))
      expect(screen.queryByTestId('focus-backdrop')).not.toBeInTheDocument()
    })

    it('renders no backdrop in focus mode when no background is selected (F-6.2)', async () => {
      install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'))
      editor.focus()
      await userEvent.keyboard('{F11}')
      await waitFor(() => expect(useFocusStore.getState().active).toBe(true))
      expect(screen.queryByTestId('focus-backdrop')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Document' }).parentElement).not.toHaveClass(
        'focus-surface'
      )
    })

    it('the toolbar button enters focus mode, and F11 toggles back out', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' })
      const button = within(toolbar).getByRole('button', { name: 'Focus mode' })
      expect(button).toHaveAttribute('aria-pressed', 'false')
      await userEvent.click(button)
      expect(invoke).toHaveBeenLastCalledWith('window:setFullScreen', { on: true })
      await waitFor(() =>
        expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument()
      )
      await userEvent.keyboard('{F11}')
      expect(fullScreenCalls(invoke)).toEqual([{ on: true }, { on: false }])
      expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    })

    it('hides the notes and assistant panels while active and brings them back on exit', async () => {
      install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' })
      await userEvent.click(within(toolbar).getByRole('button', { name: 'Notes' }))
      await userEvent.click(screen.getByRole('button', { name: 'Assistant' }))
      expect(screen.getByTestId('notes-panel')).toBeInTheDocument()
      expect(screen.getByTestId('assistant-panel')).toBeInTheDocument()

      await userEvent.keyboard('{F11}')
      await waitFor(() => expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument())
      expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
      expect(useLayoutStore.getState().layout.notes.open).toBe(true)
      expect(useLayoutStore.getState().layout.assistant.open).toBe(true)

      await userEvent.keyboard('{Escape}')
      expect(await screen.findByTestId('notes-panel')).toBeInTheDocument()
      expect(screen.getByTestId('assistant-panel')).toBeInTheDocument()
    })

    it('leaves Escape alone when something closer already claimed it', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await screen.findByRole('toolbar', { name: 'Formatting' })
      await userEvent.keyboard('{F11}')
      await waitFor(() => expect(useFocusStore.getState().active).toBe(true))
      // A popup or dialog handles its own Escape and prevents default before the bubble reaches App.
      const claim = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') event.preventDefault()
      }
      document.addEventListener('keydown', claim, true)
      try {
        await userEvent.keyboard('{Escape}')
      } finally {
        document.removeEventListener('keydown', claim, true)
      }
      expect(invoke).not.toHaveBeenCalledWith('window:setFullScreen', { on: false })
      expect(useFocusStore.getState().active).toBe(true)
      // With focus outside the editor a bare Escape reaches the document listener and leaves.
      document.body.focus()
      await userEvent.keyboard('{Escape}')
      expect(fullScreenCalls(invoke)).toEqual([{ on: true }, { on: false }])
      await waitFor(() => expect(useFocusStore.getState().active).toBe(false))
    })

    it('follows the window when fullscreen ends on its own, and reports a refused request', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await screen.findByRole('toolbar', { name: 'Formatting' })
      await userEvent.keyboard('{F11}')
      await waitFor(() =>
        expect(screen.queryByRole('toolbar', { name: 'Formatting' })).not.toBeInTheDocument()
      )
      // The window manager left fullscreen (the OS shortcut, a workspace change): no request, the chrome returns.
      fire('window:fullScreenChanged', { on: false })
      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
      expect(fullScreenCalls(invoke)).toEqual([{ on: true }])

      invoke.mockImplementationOnce(() =>
        Promise.reject(new IpcRequestError({ code: 'INTERNAL', message: 'No window' }))
      )
      await userEvent.keyboard('{F11}')
      await waitFor(() =>
        expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['No window'])
      )
      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    })

    it('mounts the control bar only in focus mode, and Exit leaves it (F-6.5)', async () => {
      const invoke = install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await screen.findByRole('toolbar', { name: 'Formatting' })
      expect(screen.queryByRole('toolbar', { name: 'Focus controls' })).not.toBeInTheDocument()

      await userEvent.keyboard('{F11}')
      const bar = await screen.findByRole('toolbar', { name: 'Focus controls' })
      // The intro shows it on entry, inside <main>, outside the editor's scroll container.
      expect(bar).toHaveAttribute('data-visible', 'true')
      expect(screen.getByRole('main')).toContainElement(bar)
      expect(
        screen.getByRole('textbox', { name: 'Document' }).closest('.overflow-y-auto')
      ).not.toContainElement(bar)
      await waitFor(() =>
        expect(screen.getByTestId('focus-words')).toHaveTextContent(/^\d[\d,]* words?$/)
      )

      await userEvent.click(within(bar).getByRole('button', { name: 'Exit focus mode' }))
      expect(fullScreenCalls(invoke)).toEqual([{ on: true }, { on: false }])
      await waitFor(() => expect(useFocusStore.getState().active).toBe(false))
      expect(screen.queryByRole('toolbar', { name: 'Focus controls' })).not.toBeInTheDocument()
      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    })

    it("floats the notes and assistant windows in focus mode on the bar's flags, never docked, closed on exit, layout flags untouched (F-6.5, F-6.6)", async () => {
      install({
        'project:current': info,
        'tree:list': treeFixture,
        'notes:get': {
          id: 'sc-1',
          notes: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Get them to the coast' }] }
            ]
          } satisfies TiptapNodeT
        }
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await screen.findByRole('toolbar', { name: 'Formatting' })
      expect(useLayoutStore.getState().layout.notes.open).toBe(false)
      expect(useLayoutStore.getState().layout.assistant.open).toBe(false)

      await userEvent.keyboard('{F11}')
      const bar = await screen.findByRole('toolbar', { name: 'Focus controls' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      const notes = within(bar).getByRole('button', { name: 'Notes' })
      const assistant = within(bar).getByRole('button', { name: 'AI assistant' })
      await userEvent.click(notes)
      expect(notes).toHaveAttribute('aria-pressed', 'true')
      const notesWindow = await screen.findByRole('dialog', { name: 'Notes' })
      expect(notesWindow).toHaveAttribute('data-testid', 'floating-notes')
      // The same notes as the docked panel: the selected node's, through the notes store.
      const notesBox = await within(notesWindow).findByRole('textbox', { name: 'Notes' })
      await waitFor(() => expect(notesBox).toHaveTextContent('Get them to the coast'))
      expect(Object.keys(useNotesStore.getState().docs)).toEqual(['sc-1'])
      // Placed from the layout's floating rect, clamped into the 1000 px wide window.
      const rect = useLayoutStore.getState().layout.floating.notes
      expect(rect).toEqual({ ...defaultFloating().notes, x: 1000 - defaultFloating().notes.width })
      expect(notesWindow.style.left).toBe(`${rect.x}px`)
      expect(notesWindow.style.width).toBe(`${rect.width}px`)
      await userEvent.click(assistant)
      expect(assistant).toHaveAttribute('aria-pressed', 'true')
      const assistantWindow = await screen.findByRole('dialog', { name: 'Assistant' })
      expect(assistantWindow).toHaveAttribute('data-testid', 'floating-assistant')
      expect(within(assistantWindow).getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
      expect(
        within(assistantWindow).getByRole('button', { name: 'New conversation' })
      ).toBeInTheDocument()
      // 2026-10-07: the references float too, with Add image in the title bar.
      const references = within(bar).getByRole('button', { name: 'References' })
      await userEvent.click(references)
      expect(references).toHaveAttribute('aria-pressed', 'true')
      const referencesWindow = await screen.findByRole('dialog', { name: 'References' })
      expect(referencesWindow).toHaveAttribute('data-testid', 'floating-references')
      expect(
        within(referencesWindow).getByRole('button', { name: 'Add image…' })
      ).toBeInTheDocument()
      await userEvent.click(
        within(referencesWindow).getByRole('button', { name: 'Close References' })
      )
      expect(references).toHaveAttribute('aria-pressed', 'false')
      // Never the docked panels; the persisted open flags did not move.
      expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('references-panel')).not.toBeInTheDocument()
      expect(asides()).toEqual([])
      expect(useLayoutStore.getState().layout.notes.open).toBe(false)
      expect(useLayoutStore.getState().layout.assistant.open).toBe(false)

      // The window's own Close clears the bar's flag; the bar's button closes the other.
      await userEvent.click(within(notesWindow).getByRole('button', { name: 'Close Notes' }))
      expect(notes).toHaveAttribute('aria-pressed', 'false')
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Notes' })).not.toBeInTheDocument()
      )
      expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeInTheDocument()
      await userEvent.click(assistant)
      expect(assistant).toHaveAttribute('aria-pressed', 'false')
      expect(screen.queryByRole('dialog', { name: 'Assistant' })).not.toBeInTheDocument()

      // Escape inside a window closes the window and keeps focus mode.
      await userEvent.click(notes)
      const reopened = await screen.findByRole('dialog', { name: 'Notes' })
      const box = await within(reopened).findByRole('textbox', { name: 'Notes' })
      box.focus()
      fireEvent.keyDown(box, { key: 'Escape', keyCode: 27 })
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Notes' })).not.toBeInTheDocument()
      )
      expect(useFocusStore.getState().active).toBe(true)
      expect(notes).toHaveAttribute('aria-pressed', 'false')

      // Leaving focus mode closes the focus-mode windows; the normal screen follows the layout (both closed).
      await userEvent.click(notes)
      await screen.findByRole('dialog', { name: 'Notes' })
      await userEvent.click(within(bar).getByRole('button', { name: 'Exit focus mode' }))
      await waitFor(() => expect(useFocusStore.getState().active).toBe(false))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
      expect(useFocusStore.getState().panels).toEqual({
        notes: false,
        assistant: false,
        references: false
      })
    })

    it('a dragged floating window persists its geometry to the layout, and it is back on reopen (F-6.6)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const invoke = install({ 'project:current': info, 'tree:list': treeFixture })
        render(<App />)
        const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
        await userEvent.click(within(scene).getByText('Scene 1'))
        await screen.findByRole('toolbar', { name: 'Formatting' })
        await userEvent.keyboard('{F11}')
        const bar = await screen.findByRole('toolbar', { name: 'Focus controls' })
        const notes = within(bar).getByRole('button', { name: 'Notes' })
        await userEvent.click(notes)
        const notesWindow = await screen.findByRole('dialog', { name: 'Notes' })
        const before = useLayoutStore.getState().layout.floating.notes
        const titleBar = within(notesWindow).getByRole('group', { name: 'Notes window' })
        fireEvent.pointerDown(titleBar, { clientX: 700, clientY: 60, button: 0, pointerId: 1 })
        fireEvent.pointerMove(titleBar, { clientX: 580, clientY: 100, pointerId: 1 })
        fireEvent.pointerUp(titleBar, { clientX: 580, clientY: 100, pointerId: 1 })
        const moved = { ...before, x: before.x - 120, y: before.y + 40 }
        expect(useLayoutStore.getState().layout.floating.notes).toEqual(moved)
        expect(notesWindow.style.left).toBe(`${moved.x}px`)
        expect(notesWindow.style.top).toBe(`${moved.y}px`)
        const grip = within(notesWindow).getByTestId('floating-notes-grip')
        fireEvent.pointerDown(grip, { clientX: 900, clientY: 400, button: 0, pointerId: 2 })
        fireEvent.pointerMove(grip, { clientX: 860, clientY: 430, pointerId: 2 })
        fireEvent.pointerUp(grip, { clientX: 860, clientY: 430, pointerId: 2 })
        const resized = { ...moved, width: moved.width - 40, height: moved.height + 30 }
        expect(useLayoutStore.getState().layout.floating.notes).toEqual(resized)
        await act(() => vi.advanceTimersByTimeAsync(200))
        const writes = invoke.mock.calls.filter(([c]) => c === 'layout:set')
        expect(writes).toHaveLength(1)
        expect(writes[0]?.[1]).toEqual({
          ...defaultLayout(),
          floating: { ...defaultFloating(), notes: resized }
        })
        // Closed and reopened: the same geometry.
        await userEvent.click(notes)
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Notes' })).not.toBeInTheDocument()
        )
        await userEvent.click(notes)
        const again = await screen.findByRole('dialog', { name: 'Notes' })
        expect(again.style.left).toBe(`${resized.x}px`)
        expect(again.style.top).toBe(`${resized.y}px`)
        expect(again.style.width).toBe(`${resized.width}px`)
        expect(again.style.height).toBe(`${resized.height}px`)
        await act(() => vi.advanceTimersByTimeAsync(200))
        expect(invoke.mock.calls.filter(([c]) => c === 'layout:set')).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('menu bar (F-7.1, F-7.7)', () => {
    it('hides the bar on the welcome screen, and File › New project from the native menu opens the wizard', async () => {
      install()
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      expect(screen.queryByRole('menubar')).not.toBeInTheDocument()
      fire('menu:action', { id: 'newProject' })
      expect(await screen.findByRole('textbox', { name: 'Project name' })).toBeInTheDocument()
      // Cancel returns to the buttons, and the flag does not leak into the next welcome screen.
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
    })

    it('shows the read-only banner after the trial and follows main when a license lands (M1)', async () => {
      const ends = new Date(2026, 10, 6).toISOString()
      install({ 'app:getAccess': { state: 'expired', trialEndsAt: ends, daysLeft: 0 } })
      render(<App />)
      expect(await screen.findByTestId('read-only-banner')).toHaveTextContent(
        'Your 30-day trial has ended.'
      )
      fire('app:accessChanged', { state: 'licensed', trialEndsAt: ends, daysLeft: 0 })
      expect(screen.queryByTestId('read-only-banner')).not.toBeInTheDocument()
    })

    it('a native menu action arrives as an event and runs: Help › Keyboard shortcuts lists the chords, About shows the version', async () => {
      install({ 'app:info': { version: '9.9.9', platform: 'linux' } })
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      fire('menu:action', { id: 'openShortcuts' })
      const reference = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
      expect(within(reference).getByRole('row', { name: /Insert scene/ })).toHaveTextContent(
        'Ctrl+Shift+S'
      )
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      fire('menu:action', { id: 'openAbout' })
      const about = await screen.findByRole('dialog', { name: 'About MythScribe' })
      await waitFor(() =>
        expect(within(about).getByTestId('about-version')).toHaveTextContent('Version 9.9.9')
      )
      await userEvent.click(within(about).getByRole('button', { name: 'OK' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('a project item from the native menu without a project toasts instead of running', async () => {
      const invoke = install()
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      fire('menu:action', { id: 'saveDocument' })
      await waitFor(() =>
        expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
          'Open a project first.'
        ])
      )
      expect(invoke).not.toHaveBeenCalledWith('document:save', expect.anything())
    })

    it('Insert › Scene from the bar creates after the selection; View › Notes toggles the panel; Tools › Settings opens the dialog', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture,
        'tree:create': createdScene
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await screen.findByRole('textbox', { name: 'Document' })
      const bar = screen.getByRole('menubar', { name: 'Application menu' })

      await userEvent.click(within(bar).getByRole('menuitem', { name: 'Insert' }))
      const insert = screen.getByRole('menu', { name: 'Insert' })
      // Web novel labels the top level "Arc"; the scene item carries its chord. F-9.3 adds the
      // three story-bible items after the levels.
      expect(
        within(insert)
          .getAllByRole('menuitem')
          .map((m) => m.textContent)
      ).toEqual([
        'SceneCtrl+Shift+S',
        'ChapterCtrl+Shift+C',
        'ArcCtrl+Shift+P',
        'Character',
        'Setting',
        'World-building note',
        'Scene break'
      ])
      expect(within(insert).getByRole('menuitem', { name: 'Scene' })).toHaveAttribute(
        'aria-keyshortcuts',
        'Ctrl+Shift+S'
      )
      await userEvent.click(within(insert).getByRole('menuitem', { name: 'Scene' }))
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('tree:create', {
          parentId: 'ch-1',
          afterId: 'sc-1',
          kind: 'document',
          hierarchyLevel: 'scene'
        })
      )

      expect(screen.queryByRole('complementary', { name: 'Notes' })).not.toBeInTheDocument()
      await userEvent.click(within(bar).getByRole('menuitem', { name: 'View' }))
      await userEvent.click(
        within(screen.getByRole('menu', { name: 'View' })).getByRole('menuitem', { name: 'Notes' })
      )
      expect(useLayoutStore.getState().layout.notes.open).toBe(true)

      await userEvent.click(within(bar).getByRole('menuitem', { name: 'Tools' }))
      await userEvent.click(
        within(screen.getByRole('menu', { name: 'Tools' })).getByRole('menuitem', {
          name: 'Settings'
        })
      )
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('a confirm raised from inside a shell dialog renders after it, so it stacks on top', async () => {
      install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      await screen.findByRole('treeitem', { name: 'Scene 1' })
      fire('menu:action', { id: 'openSettings' })
      const settings = await screen.findByRole('dialog', { name: 'Settings' })
      void dialogs.confirm({ title: 'Delete it?', message: 'Sure?' })
      const confirm = await screen.findByRole('dialog', { name: 'Delete it?' })
      expect(
        settings.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('File › Close project confirms like the header button', async () => {
      const invoke = install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      await screen.findByRole('treeitem', { name: 'Scene 1' })
      fire('menu:action', { id: 'closeProject' })
      await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
      expect(await screen.findByRole('button', { name: /new project/i })).toBeInTheDocument()
      expect(invoke).toHaveBeenCalledWith('project:close', undefined)
    })

    it('Ctrl+, opens Settings in focus mode too, and the native View › AI assistant floats the panel there (F-6.1 gap)', async () => {
      install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      editor.focus()
      await userEvent.keyboard('{F11}')
      await waitFor(() => expect(useFocusStore.getState().active).toBe(true))
      expect(screen.queryByRole('banner')).not.toBeInTheDocument()
      await userEvent.keyboard('{Control>},{/Control}')
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      // The dialog's Escape was claimed, so focus mode stayed.
      expect(useFocusStore.getState().active).toBe(true)
      fire('menu:action', { id: 'toggleAssistant' })
      expect(await screen.findByTestId('floating-assistant')).toBeInTheDocument()
      expect(useLayoutStore.getState().layout.assistant.open).toBe(false)
    })

    // Regression (verifier finding, F-7.1): `shellDialogStore.open` is never cleared when the
    // project closes. The DOM overlay blocks the header and the in-app bar while a shell dialog
    // is up, but the native OS menu is not part of the DOM, so File › Close project (or its
    // native accelerator-free click) still reaches `closeProjectWithConfirm` behind an open
    // Settings dialog. `ShellDialogs` then renders null only because `format` is briefly null
    // (no project); once any project becomes current again, `open` is still `'settings'` and
    // the dialog reappears unrequested.
    it('closing the project behind an open Settings dialog does not resurrect it on the next project (currently fails)', async () => {
      install({ 'project:current': info, 'tree:list': treeFixture })
      render(<App />)
      await screen.findByTestId('project-name')
      fire('menu:action', { id: 'openSettings' })
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()

      // The native File › Close project menu reaches the app even though the DOM overlay of
      // the open dialog would block the header button and the in-app bar underneath it.
      fire('menu:action', { id: 'closeProject' })
      await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
      await screen.findByRole('button', { name: /new project/i })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      // A second project becomes current (opened or created); Settings must stay closed.
      useProjectStore.setState({ current: { ...info, id: '2', name: 'Second' } })
      await screen.findByTestId('project-name')
      expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
    })
  })

  describe('insert shortcuts (F-2.7)', () => {
    it('Ctrl+Shift+S inserts a scene after the selected scene, captured before the editor', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture,
        'tree:create': createdScene
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      editor.focus()
      await userEvent.keyboard('{Control>}{Shift>}S{/Shift}{/Control}')
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('tree:create', {
          parentId: 'ch-1',
          afterId: 'sc-1',
          kind: 'document',
          hierarchyLevel: 'scene'
        })
      )
      // The editor's own Mod-Shift-S (strikethrough) did not fire for the chord.
      expect(editor.querySelector('s')).toBeNull()
    })

    it('Ctrl+Shift+C inserts a chapter after the enclosing chapter', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture,
        'tree:create': {
          ...createdScene,
          id: 'new-ch',
          parentId: 'arc-1',
          kind: 'folder',
          hierarchyLevel: 'chapter',
          title: 'Untitled Chapter'
        }
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      await userEvent.keyboard('{Control>}{Shift>}C{/Shift}{/Control}')
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('tree:create', {
          parentId: 'arc-1',
          afterId: 'ch-1',
          kind: 'folder',
          hierarchyLevel: 'chapter'
        })
      )
    })

    it('explains itself when the selection cannot take the level', async () => {
      const invoke = install({
        'project:current': { ...info, name: 'Serial', format: 'webnovel' },
        'tree:list': treeFixture
      })
      render(<App />)
      const page = await screen.findByRole('treeitem', { name: 'Title Page' })
      await userEvent.click(within(page).getByText('Title Page'))
      await userEvent.keyboard('{Control>}{Shift>}P{/Shift}{/Control}')
      // Web novel labels the top level "Arc"; front matter is outside every manuscript level.
      await waitFor(() =>
        expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
          'Select something in the manuscript to insert the arc after it.'
        ])
      )
      expect(invoke).not.toHaveBeenCalledWith('tree:create', expect.anything())
    })
  })

  describe('theme (F-7.8)', () => {
    const SEPIA_LIKE = {
      id: 'custom-0123456789ab',
      name: 'Parchment',
      base: 'sepia',
      colors: {
        bg: '#f0e0c0',
        surface: '#e6d8ba',
        surfaceRaised: '#f7eedb',
        line: '#d3c29d',
        fg: '#3b2f22',
        fgMuted: '#6e5d48',
        desk: '#f0e0c0',
        sheet: '#f7eedb'
      }
    } as const
    const licensed = (on: boolean): unknown => ({
      licensed: on,
      since: on ? '2026-09-20T10:00:00.000Z' : null,
      validUntil: null,
      offline: false,
      product: null,
      accent: 'default'
    })
    const html = document.documentElement
    afterEach(() => {
      delete html.dataset.theme
      delete html.dataset.scheme
      html.removeAttribute('style')
    })

    it('paints the stored built-in theme on <html>, scheme included, and Dark as no attribute', async () => {
      install({ 'view:get': { ...defaultViewSettings(), theme: 'light' } })
      render(<App />)
      await waitFor(() => expect(html.dataset.theme).toBe('light'))
      expect(html.dataset.scheme).toBe('light')
      expect(html.style.colorScheme).toBe('light')
      act(() => useViewStore.setState({ theme: 'dark' }))
      expect(html.dataset.theme).toBeUndefined()
      expect(html.dataset.scheme).toBe('dark')
    })

    it('lays a licensed custom theme over its base as inline variables, and paints Dark without the license', async () => {
      install({
        'view:get': { ...defaultViewSettings(), theme: SEPIA_LIKE.id, customThemes: [SEPIA_LIKE] },
        'account:getSupporter': licensed(true)
      })
      render(<App />)
      await waitFor(() => expect(html.dataset.theme).toBe('sepia'))
      expect(html.style.getPropertyValue('--ms-bg')).toBe('#f0e0c0')
      expect(html.style.getPropertyValue('--ms-surface-raised')).toBe('#f7eedb')
      // The license lapses (a sign-out): the choice stays stored, the window paints Dark.
      act(() => useAccountStore.setState({ supporter: null }))
      expect(html.dataset.theme).toBeUndefined()
      expect(html.style.getPropertyValue('--ms-bg')).toBe('')
      expect(useViewStore.getState().theme).toBe(SEPIA_LIKE.id)
    })
  })

  describe('document zoom (F-7.10)', () => {
    it('reads the persisted level at start, so the first editor paints at it', async () => {
      install({
        'project:current': info,
        'tree:list': treeFixture,
        'view:get': { editorZoom: 1.25, uiScale: 'large', pageEdges: true }
      })
      render(<App />)
      await waitFor(() => expect(useViewStore.getState().editorZoom).toBe(1.25))
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      // The pane the column variables sit on: 16 px × 1.25 and 700 px × 1.25 (F-3.6 defaults).
      const pane = editor.closest('[style*="--ms-editor-font-size"]')
      expect(pane).toHaveStyle({ '--ms-editor-font-size': '20px' })
      expect(pane).toHaveStyle({ '--ms-editor-max-width': '875px' })
    })

    it('Ctrl+= and Ctrl+0 zoom the document from the welcome screen, each announced as a toast', async () => {
      const invoke = install({
        'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium', pageEdges: true }
      })
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      await userEvent.keyboard('{Control>}={/Control}')
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('view:zoomDocument', { step: 'in' }))
      await userEvent.keyboard('{Control>}-{/Control}')
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('view:zoomDocument', { step: 'out' }))
      await userEvent.keyboard('{Control>}0{/Control}')
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('view:zoomDocument', { step: 'reset' })
      )
      // Main answers with the level it applied; every keystroke says where the zoom landed.
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
        'Document zoom 110 %',
        'Document zoom 110 %',
        'Document zoom 110 %'
      ])
    })

    it('is captured before the editor, so the chord never types into the document', async () => {
      const invoke = install({
        'project:current': info,
        'tree:list': treeFixture,
        'view:zoomDocument': { editorZoom: 0.9, uiScale: 'medium', pageEdges: true }
      })
      render(<App />)
      const scene = await screen.findByRole('treeitem', { name: 'Scene 1' })
      await userEvent.click(within(scene).getByText('Scene 1'))
      const editor = await screen.findByRole('textbox', { name: 'Document' })
      editor.focus()
      await userEvent.keyboard('{Control>}={/Control}')
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('view:zoomDocument', { step: 'in' }))
      expect(editor.textContent).not.toContain('=')
    })

    it('Ctrl+wheel steps once per burst and the plain wheel is left to scroll', async () => {
      const invoke = install({
        'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium', pageEdges: true }
      })
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      const zoomCalls = (): number =>
        invoke.mock.calls.filter(([channel]) => channel === 'view:zoomDocument').length

      // A notch emits several deltas; they are one step, and the page must not scroll under it.
      const first = createWheel({ deltaY: -120, ctrlKey: true })
      fireEvent(document, first)
      fireEvent(document, createWheel({ deltaY: -12, ctrlKey: true }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('view:zoomDocument', { step: 'in' }))
      expect(zoomCalls()).toBe(1)
      expect(first.defaultPrevented).toBe(true)

      // Without Ctrl it is a scroll, and the listener leaves it alone.
      const scroll = createWheel({ deltaY: -120 })
      fireEvent(document, scroll)
      expect(scroll.defaultPrevented).toBe(false)
      expect(zoomCalls()).toBe(1)
    })
  })
})

/** A wheel event jsdom can dispatch; `fireEvent.wheel` does not carry `ctrlKey` on its own. */
function createWheel(init: WheelEventInit): WheelEvent {
  return new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
}
