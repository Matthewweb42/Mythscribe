import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { LAYOUT_LIMITS, defaultLayout } from '@shared/layout'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import { UNAVAILABLE_SUMMARY } from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetSessionStore } from '@renderer/features/project/sessionStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { DockColumn } from '@renderer/features/shell/Dock'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import {
  resetReferenceStore,
  useReferenceStore
} from '@renderer/features/references/referenceStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { NotesPanel, NotesToggleButton } from './NotesPanel'
import { resetNotesStore } from './notesStore'
import { resetSceneMetaStore, useSceneMetaStore } from './sceneMetaStore'
import { resetSummaryStore } from './summaryStore'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** `notes:get` answers at once with `stored`; `notes:save` records its input. */
function client(stored: Record<string, TiptapNodeT>): {
  client: IpcClient
  gets: string[]
  saves: Input<'notes:save'>[]
} {
  const gets: string[] = []
  const saves: Input<'notes:save'>[] = []
  return {
    gets,
    saves,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        if (channel === 'notes:get') {
          const { id } = input as Input<'notes:get'>
          gets.push(id)
          return { id, notes: stored[id] ?? null } as Output<C>
        }
        if (channel === 'notes:save') {
          saves.push(input as Input<'notes:save'>)
          return { modified: 'm' } as Output<C>
        }
        // F-9.6: the pin button writes the list; main answers what it stored.
        if (channel === 'reference:set') return input as Output<C>
        // The synopsis box and the scene details read the node's metadata.
        if (channel === 'sceneMeta:get') {
          const { id } = input as Input<'sceneMeta:get'>
          return { id, meta: { ...EMPTY_SCENE_META, synopsis: `About ${id}` } } as Output<C>
        }
        if (channel === 'summary:get') return UNAVAILABLE_SUMMARY as Output<C>
        // The toggle and the resize write the layout after its debounce; refused, the store
        // would undo them under a test slower than the debounce.
        if (channel === 'layout:set') return input as Output<C>
        throw new Error(`unexpected ${channel}`)
      },
      on: () => () => {}
    }
  }
}

/** jsdom has no layout; the window width the drag deltas are divided by is stubbed. */
const WINDOW_WIDTH = 1000
const DEFAULT_SIZE = defaultLayout().notes.size

let gets: string[]
let saves: Input<'notes:save'>[]

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize notes' })
/** The stored fraction, as the source of truth the `vw` width and the ARIA percent derive from. */
const size = (): number => useLayoutStore.getState().layout.notes.size
const panel = (): HTMLElement => screen.getByTestId('notes-panel')
/** The dock column the panel sits in (layout 3c), which carries the width and the handle. */
const column = (): HTMLElement => screen.getByTestId('dock-column')
const openNotes = (): void => act(() => useLayoutStore.getState().toggle('notes'))

function Host({ id }: { id: string | null }): React.JSX.Element {
  return (
    <div>
      <NotesToggleButton />
      <div className="flex">
        <div>editor</div>
        <DockColumn column={['notes']} side="left" render={() => <NotesPanel id={id} />} />
      </div>
    </div>
  )
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', WINDOW_WIDTH)
  resetLayoutStore()
  resetSessionStore()
  resetReferenceStore()
  resetNotesStore()
  resetSceneMetaStore()
  resetSummaryStore()
  resetDocumentStore()
  resetPendingSaves()
  useTreeStore.setState({ ...buildIndex([]), loaded: false })
  useDialogStore.setState({ modals: [], toasts: [] })
  const fake = client({ 'sc-1': doc('Scene note'), 'ch-1': doc('Chapter note') })
  gets = fake.gets
  saves = fake.saves
  setIpcClient(fake.client)
})
afterEach(() => {
  // The layout store's write is debounced; leaving it pending leaks into the next file.
  resetLayoutStore()
  resetSceneMetaStore()
  resetSummaryStore()
  vi.unstubAllGlobals()
})

describe('NotesPanel (F-3.7)', () => {
  it('starts closed; the toolbar button toggles it and reports aria-pressed', async () => {
    render(<Host id="sc-1" />)
    const button = screen.getByRole('button', { name: 'Notes' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
    expect(gets).toEqual([])

    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(panel()).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()

    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
  })

  it('pins the notes of the node it shows to References and unpins them (F-9.6)', async () => {
    openNotes()
    const { rerender } = render(<Host id="sc-1" />)
    const pin = screen.getByRole('button', { name: 'Pin notes' })
    expect(pin).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pin)
    expect(useReferenceStore.getState().pins).toEqual([{ type: 'note', id: 'sc-1' }])
    expect(useLayoutStore.getState().layout.references.open).toBe(true)
    expect(screen.getByRole('button', { name: 'Unpin notes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // Another node's notes are not pinned.
    rerender(<Host id="ch-1" />)
    expect(screen.getByRole('button', { name: 'Pin notes' })).toBeInTheDocument()
    rerender(<Host id="sc-1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Unpin notes' }))
    expect(useReferenceStore.getState().pins).toEqual([])
  })

  it('loads the notes for the id it is given and follows an id change', async () => {
    openNotes()
    const { rerender } = render(<Host id="sc-1" />)
    // The editor remounts once the load lands, so the textbox is queried fresh each time.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveTextContent('Scene note')
    )
    expect(gets).toEqual(['sc-1'])
    rerender(<Host id="ch-1" />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveTextContent('Chapter note')
    )
    expect(gets).toEqual(['sc-1', 'ch-1'])
    expect(saves).toHaveLength(0)
  })

  it('opens at the stored fraction of the window and the arrow keys resize it, clamped to its limits (F-7.2)', async () => {
    openNotes()
    render(<Host id="sc-1" />)
    expect(size()).toBe(DEFAULT_SIZE)
    expect(column().style.width).toBe(`${DEFAULT_SIZE * 100}vw`)
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-valuenow', String(Math.round(DEFAULT_SIZE * 100)))
    expect(handle()).toHaveAttribute('aria-valuemin', '15')
    expect(handle()).toHaveAttribute('aria-valuemax', '50')

    handle().focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(size()).toBeCloseTo(DEFAULT_SIZE + 16 / WINDOW_WIDTH)
    expect(column().style.width).toBe(`${(DEFAULT_SIZE + 16 / WINDOW_WIDTH) * 100}vw`)
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(size()).toBeCloseTo(DEFAULT_SIZE - 16 / WINDOW_WIDTH)

    for (let i = 0; i < 20; i++) await userEvent.keyboard('{ArrowRight}')
    expect(size()).toBe(LAYOUT_LIMITS.notes[0])
    expect(handle()).toHaveAttribute('aria-valuenow', '15')

    // The sidebar is open at its default, so the editor minimum caps the notes under their own maximum.
    for (let i = 0; i < 40; i++) await userEvent.keyboard('{ArrowLeft}')
    expect(size()).toBeCloseTo(1 - LAYOUT_LIMITS.editorMin - defaultLayout().sidebar.size)
    expect(handle()).toHaveAttribute('aria-valuenow', '48')
  })

  it('a pointer drag on the handle changes the width: left widens, right narrows', () => {
    openNotes()
    render(<Host id="sc-1" />)
    fireEvent.pointerDown(handle(), { clientX: 600, button: 0 })
    fireEvent.pointerMove(window, { clientX: 550 })
    expect(size()).toBeCloseTo(DEFAULT_SIZE + 50 / WINDOW_WIDTH)
    fireEvent.pointerMove(window, { clientX: 640 })
    expect(size()).toBeCloseTo(DEFAULT_SIZE - 40 / WINDOW_WIDTH)
    fireEvent.pointerUp(window, { clientX: 640 })
    // After release, movement no longer resizes.
    fireEvent.pointerMove(window, { clientX: 300 })
    expect(size()).toBeCloseTo(DEFAULT_SIZE - 40 / WINDOW_WIDTH)
    expect(column().style.width).toBe(`${size() * 100}vw`)
  })

  it('keeps the width across a close and reopen', async () => {
    openNotes()
    render(<Host id="sc-1" />)
    handle().focus()
    await userEvent.keyboard('{ArrowLeft}')
    const button = screen.getByRole('button', { name: 'Notes' })
    await userEvent.click(button)
    expect(screen.queryByTestId('notes-panel')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(size()).toBeCloseTo(DEFAULT_SIZE + 16 / WINDOW_WIDTH)
  })

  it('shows a hint and no pin while no node is selected', () => {
    openNotes()
    render(<Host id={null} />)
    expect(panel()).toHaveTextContent('Select a document to see its notes.')
    expect(screen.queryByRole('button', { name: 'Pin notes' })).not.toBeInTheDocument()
    expect(gets).toEqual([])
  })

  it('puts the synopsis box above the notes and keeps the scene details collapsed for a scene', async () => {
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    openNotes()
    render(<Host id="sc-1" />)
    const synopsis = screen.getByRole('textbox', { name: 'Synopsis' })
    await waitFor(() => expect(synopsis).toHaveValue('About sc-1'))
    const details = screen.getByRole('button', { name: 'Scene details' })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Scene metadata' })).not.toBeInTheDocument()
    await userEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    const metadata = screen.getByRole('group', { name: 'Scene metadata' })
    // The synopsis is the box at the top, never repeated in the details.
    expect(screen.getAllByRole('textbox', { name: 'Synopsis' })).toHaveLength(1)
    expect(metadata).not.toContainElement(synopsis)
  })

  it('shows where the notes stand, Plan by default, and the picker edits the node’s metadata (F-5.24)', async () => {
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    openNotes()
    render(<Host id="sc-1" />)
    const picker = screen.getByRole('combobox', { name: 'Notes status' })
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveValue('plan')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Canon',
      'Plan',
      'Idea'
    ])
    await userEvent.selectOptions(picker, 'canon')
    expect(picker).toHaveValue('canon')
    expect(useSceneMetaStore.getState().docs['sc-1']?.content?.notesStatus).toBe('canon')
  })

  it('has notes only, no synopsis or details, for a node without a hierarchy level', () => {
    openNotes()
    // The empty tree knows no level for `sc-1`.
    render(<Host id="sc-1" />)
    expect(screen.queryByRole('textbox', { name: 'Synopsis' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Scene details' })).not.toBeInTheDocument()
  })
})
