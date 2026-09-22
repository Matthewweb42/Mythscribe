import { defaultFocusSettings } from '@shared/focus'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import { defaultAuthorRules } from '@shared/authorRules'
import type { Conversations } from '@shared/chat'
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
import { defaultFloating, defaultLayout } from '@shared/layout'
import { defaultViewSettings } from '@shared/zoom'
import type { TiptapNodeT } from '@shared/tiptap'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAuthorRulesStore, useAuthorRulesStore } from '@renderer/features/ai/authorRulesStore'
import { resetAssistantStore, useAssistantStore } from '@renderer/features/ai/assistantStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { resetIndexingStore } from '@renderer/features/ai/indexingStore'
import { resetBackgroundStore } from '@renderer/features/focus/backgroundStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { dialogs, useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { resetWelcomeStore } from '@renderer/features/project/welcomeStore'
import { resetShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
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
const listeners = new Map<string, (payload: never) => void>()

beforeEach(() => {
  listeners.clear()
  resetPendingSaves()
  useProjectStore.setState({ current: null, ready: false, busy: false, recents: [] })
  useTreeStore.getState().clear()
  useDocumentStore.getState().clear()
  useNotesStore.getState().clear()
  resetLayoutStore()
  resetEditorSettingsStore()
  resetAiSettingsStore()
  resetAuthorRulesStore()
  resetAssistantStore()
  resetTagStore()
  resetFocusStore()
  resetBackgroundStore()
  resetShellDialogStore()
  resetWelcomeStore()
  resetIndexingStore()
  resetAccountStore()
  resetViewStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  document.title = ''
  // jsdom has no layout; the drag deltas of the resize handles are divided by this.
  vi.stubGlobal('innerWidth', 1000)
})
afterEach(() => {
  resetAiSettingsStore()
  resetAuthorRulesStore()
  resetAssistantStore()
  resetBackgroundStore()
  resetIndexingStore()
  resetViewStore()
  vi.unstubAllGlobals()
})

/** The stacked document regions (`<section>`), leaving out the folder's own tag bar region (F-4.5). */
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
    if (channel === 'documentTag:list') return []
    if (channel === 'sceneMeta:get')
      return { id: (input as { id: string }).id, meta: { location: '', pov: '', timeline: '' } }
    if (channel === 'document:get') return { id: (input as { id: string }).id, content: null }
    if (channel === 'notes:get') return { id: (input as { id: string }).id, notes: null }
    if (channel === 'editorSettings:get') return defaultEditorSettings('novel')
    if (channel === 'aiSettings:get') return defaultAiSettings()
    if (channel === 'authorRules:get') return defaultAuthorRules()
    if (channel === 'layout:get') return defaultLayout()
    if (channel === 'layout:set') return input
    if (channel === 'window:setFullScreen') return input // the fake window does what it is asked
    if (channel === 'conversations:get') return { active: null, items: [] }
    if (channel === 'focusSettings:get') return { ...defaultFocusSettings(), backgroundId: null }
    if (channel === 'background:list') return []
    if (channel === 'jobs:status') return IDLE_INDEX_QUEUE
    if (channel === 'view:get') return defaultViewSettings()
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

async function fillWizard(name: string, format: RegExp, source?: RegExp): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
  await userEvent.type(await screen.findByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('radio', { name: format }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  if (source) await userEvent.click(await screen.findByRole('radio', { name: source }))
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

describe('App', () => {
  it('shows the welcome screen, creates a project through the wizard, then closes it', async () => {
    const invoke = install({ 'project:create': { ...info, format: 'epic' } })
    render(<App />)
    await fillWizard('Smoke', /^epic/i, /^mythscribe cloud/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    // F-15.11: the wizard's third step travels with the create, so main stores it with the project.
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'epic',
      directory: undefined,
      aiSource: 'cloud'
    })
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
    expect(screen.getByRole('banner')).toHaveTextContent('/ Serial · Web novel')
    expect(document.title).toBe('Serial — MythScribe')
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
    // F-4.2: the tag bank loads with the project and the Tags tab is registered beside Manuscript.
    await waitFor(() => expect(useTagStore.getState().loaded).toBe(true))
    expect(useTagStore.getState().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    expect(
      within(aside)
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Manuscript', 'Tags'])

    await userEvent.click(screen.getByRole('button', { name: /close project/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: /new project/i })
    expect(document.title).toBe('MythScribe')
    // F-7.1: the menu bar stays; the project segment is gone.
    expect(screen.getByRole('banner')).toHaveTextContent(/^MythScribeFileEditInsertViewToolsHelp$/)
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
    expect(screen.getByText('Scene · Volume 1')).toBeInTheDocument()
    // F-3.1: a document mounts the editor and its toolbar, loaded through document:get.
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
    const box = await screen.findByRole('textbox', { name: 'Document' })
    expect(invoke).toHaveBeenCalledWith('document:get', { id: 'sc-1' })
    await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'true'))

    await userEvent.click(
      within(screen.getByRole('treeitem', { name: 'Arc 2' })).getByText('Arc 2')
    )
    expect(screen.getByTestId('selected-title')).toHaveTextContent('Arc 2')
    expect(screen.getByText('Arc · Volume 1')).toBeInTheDocument()
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
        tagBar: { open: true, height: 180, split: 0.4 },
        assistant: { open: false, size: 0.3 },
        floating: defaultFloating()
      }
    })
    render(<App />)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).toHaveBeenCalledWith('layout:get', undefined)
    await waitFor(() => expect(useLayoutStore.getState().layout.sidebar.size).toBe(0.3))
    const aside = screen.getByRole('complementary')
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
      const aside = screen.getByRole('complementary')
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
        tagBar: { open: true, height: 180, split: 0.4 },
        assistant: { open: false, size: 0.3 },
        floating: defaultFloating()
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
    expect(screen.getByRole('complementary').style.width).toBe('22vw')
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
      'aiSettings:get': { ...defaultAiSettings(), dial: 2 }
    })
    render(<App />)
    await screen.findByRole('treeitem', { name: 'Scene 1' })
    await waitFor(() => expect(useAiSettingsStore.getState().settings?.dial).toBe(2))
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
    expect(panel.style.width).toBe('30vw')
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

  it('opens Settings on the welcome screen with only the app-wide tabs (F-7.5, F-15.2, F-15.7, F-15.8, F-7.10)', async () => {
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
    ).toEqual(['Appearance', 'Account', 'Updates', 'Diagnostics'])
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
    const wizard = screen.getByRole('dialog', { name: 'Choose an AI source' })
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
      aiSource: 'ownKey'
    })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('dialog', { name: 'Choose an AI source' })).toBeInTheDocument()
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
    /** What was asked of the window, in order (leaving fullscreen remounts the tag bar, whose own calls follow). */
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
      expect(screen.getByRole('complementary')).toBeInTheDocument()
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
      // Never the docked panels; the persisted open flags did not move.
      expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
      expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
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
      expect(useFocusStore.getState().panels).toEqual({ notes: false, assistant: false })
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
    it('shows the bar on the welcome screen with the project items disabled, and File › New project opens the wizard', async () => {
      install()
      render(<App />)
      await screen.findByRole('button', { name: /new project/i })
      const bar = screen.getByRole('menubar', { name: 'Application menu' })
      expect(
        within(bar)
          .getAllByRole('menuitem')
          .map((m) => m.textContent)
      ).toEqual(['File', 'Edit', 'Insert', 'View', 'Tools', 'Help'])
      await userEvent.click(within(bar).getByRole('menuitem', { name: 'File' }))
      const file = screen.getByRole('menu', { name: 'File' })
      expect(within(file).getByRole('menuitem', { name: 'Save' })).toHaveAttribute(
        'aria-disabled',
        'true'
      )
      await userEvent.click(within(file).getByRole('menuitem', { name: 'New project' }))
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(await screen.findByRole('textbox', { name: 'Project name' })).toBeInTheDocument()
      // Cancel returns to the buttons, and the flag does not leak into the next welcome screen.
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument()
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
      // Web novel labels the top level "Arc"; the scene item carries its chord.
      expect(
        within(insert)
          .getAllByRole('menuitem')
          .map((m) => m.textContent)
      ).toEqual(['SceneCtrl+Shift+S', 'ChapterCtrl+Shift+C', 'ArcCtrl+Shift+P', 'Scene break'])
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

  describe('document zoom (F-7.10)', () => {
    it('reads the persisted level at start, so the first editor paints at it', async () => {
      install({
        'project:current': info,
        'tree:list': treeFixture,
        'view:get': { editorZoom: 1.25, uiScale: 'large' }
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
        'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium' }
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
        'view:zoomDocument': { editorZoom: 0.9, uiScale: 'medium' }
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
      const invoke = install({ 'view:zoomDocument': { editorZoom: 1.1, uiScale: 'medium' } })
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
