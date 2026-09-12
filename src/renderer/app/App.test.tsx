import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { defaultLayout } from '@shared/layout'
import type { TiptapNodeT } from '@shared/tiptap'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
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
  resetTagStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  document.title = ''
  // jsdom has no layout; the drag deltas of the resize handles are divided by this.
  vi.stubGlobal('innerWidth', 1000)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

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
    if (channel === 'document:get') return { id: (input as { id: string }).id, content: null }
    if (channel === 'notes:get') return { id: (input as { id: string }).id, notes: null }
    if (channel === 'editorSettings:get') return defaultEditorSettings('novel')
    if (channel === 'layout:get') return defaultLayout()
    if (channel === 'layout:set') return input
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

async function fillWizard(name: string, format: RegExp): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
  await userEvent.type(await screen.findByRole('textbox', { name: 'Project name' }), name)
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(await screen.findByRole('radio', { name: format }))
  await userEvent.click(screen.getByRole('button', { name: 'Create' }))
}

describe('App', () => {
  it('shows the welcome screen, creates a project through the wizard, then closes it', async () => {
    const invoke = install({ 'project:create': { ...info, format: 'epic' } })
    render(<App />)
    await fillWizard('Smoke', /^epic/i)
    expect(await screen.findByTestId('project-name')).toHaveTextContent('Smoke')
    expect(invoke).toHaveBeenCalledWith('project:create', {
      name: 'Smoke',
      format: 'epic',
      directory: undefined
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
    expect(screen.getByRole('banner')).toHaveTextContent(/^MythScribe$/)
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
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
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
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Untitled Scene'
    ])
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
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Scene 1'
    ])
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
        notes: { open: false, size: 0.25 }
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
        notes: { open: false, size: 0.25 }
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

  it('does not show the Settings button on the welcome screen, and Ctrl+, does nothing (F-7.5)', async () => {
    install()
    render(<App />)
    await screen.findByRole('button', { name: /new project/i })
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Control>},{/Control}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    const wizard = screen.getByRole('dialog', { name: 'Choose a format' })
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
      directory: undefined
    })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('dialog', { name: 'Choose a format' })).toBeInTheDocument()
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
})
