import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { NotesPanel, NotesToggleButton } from './NotesPanel'
import {
  DEFAULT_WIDTH,
  MIN_WIDTH,
  resetNotesPanelStore,
  useNotesPanelStore
} from './notesPanelStore'
import { resetNotesStore } from './notesStore'

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
        throw new Error(`unexpected ${channel}`)
      },
      on: () => () => {}
    }
  }
}

/** jsdom has no layout and no ResizeObserver; the test controls the container width directly. */
let containerWidth = 1000
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')

let gets: string[]
let saves: Input<'notes:save'>[]

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize notes' })
const width = (): number => Number(handle().getAttribute('aria-valuenow'))
const panel = (): HTMLElement => screen.getByTestId('notes-panel')

function Host({ id }: { id: string }): React.JSX.Element {
  return (
    <div>
      <NotesToggleButton />
      <div className="flex">
        <div>editor</div>
        <NotesPanel id={id} />
      </div>
    </div>
  )
}

beforeEach(() => {
  containerWidth = 1000
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => containerWidth
  })
  resetNotesPanelStore()
  resetNotesStore()
  resetDocumentStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const fake = client({ 'sc-1': doc('Scene note'), 'ch-1': doc('Chapter note') })
  gets = fake.gets
  saves = fake.saves
  setIpcClient(fake.client)
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
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

  it('loads the notes for the id it is given and follows an id change', async () => {
    act(() => useNotesPanelStore.getState().toggle())
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

  it('opens at the default width and the arrow keys resize it, clamped to the minimum and half the container', async () => {
    act(() => useNotesPanelStore.getState().toggle())
    render(<Host id="sc-1" />)
    expect(width()).toBe(DEFAULT_WIDTH)
    expect(panel().style.width).toBe(`${DEFAULT_WIDTH}px`)
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-valuemin', String(MIN_WIDTH))
    expect(handle()).toHaveAttribute('aria-valuemax', '500')

    handle().focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(width()).toBe(DEFAULT_WIDTH + 16)
    expect(panel().style.width).toBe(`${DEFAULT_WIDTH + 16}px`)
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(width()).toBe(DEFAULT_WIDTH - 16)

    for (let i = 0; i < 20; i++) await userEvent.keyboard('{ArrowRight}')
    expect(width()).toBe(MIN_WIDTH)
    expect(useNotesPanelStore.getState().width).toBe(MIN_WIDTH)

    for (let i = 0; i < 30; i++) await userEvent.keyboard('{ArrowLeft}')
    expect(width()).toBe(500)
  })

  it('a pointer drag on the handle changes the width: left widens, right narrows', () => {
    act(() => useNotesPanelStore.getState().toggle())
    render(<Host id="sc-1" />)
    fireEvent.pointerDown(handle(), { clientX: 600 })
    fireEvent.pointerMove(window, { clientX: 550 })
    expect(width()).toBe(DEFAULT_WIDTH + 50)
    fireEvent.pointerMove(window, { clientX: 640 })
    expect(width()).toBe(DEFAULT_WIDTH - 40)
    fireEvent.pointerUp(window, { clientX: 640 })
    // After release, movement no longer resizes.
    fireEvent.pointerMove(window, { clientX: 300 })
    expect(width()).toBe(DEFAULT_WIDTH - 40)
    expect(useNotesPanelStore.getState().width).toBe(DEFAULT_WIDTH - 40)
  })

  it('keeps the width across a close and reopen within the session', async () => {
    act(() => useNotesPanelStore.getState().toggle())
    render(<Host id="sc-1" />)
    handle().focus()
    await userEvent.keyboard('{ArrowLeft}')
    const button = screen.getByRole('button', { name: 'Notes' })
    await userEvent.click(button)
    await userEvent.click(button)
    expect(width()).toBe(DEFAULT_WIDTH + 16)
  })
})
