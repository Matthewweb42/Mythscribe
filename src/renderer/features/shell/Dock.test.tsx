import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_EDGE_PX, type DockPanelId } from '@shared/dock'
import { defaultLayout } from '@shared/layout'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient } from '@renderer/lib/ipc'
import { DockColumn, DockPanelControls, DockSlot } from './Dock'
import { DOCK_DRAG_TYPE, resetDockDrag, useDockDragStore } from './dockDragStore'
import { resetLayoutStore, useLayoutStore } from './layoutStore'

/** A panel body with its grip and menu, as the real panels put them in their headers. */
function Body({ id }: { id: DockPanelId }): React.JSX.Element {
  return (
    <div data-testid={`body-${id}`}>
      <DockPanelControls id={id} />
    </div>
  )
}

/** The editor slot and every open side column, in dock order, like the project screen. */
function Screen(): React.JSX.Element {
  const columns = useLayoutStore((s) => s.layout.dock.columns)
  const editorAt = columns.findIndex((c) => c.includes('editor'))
  return (
    <div>
      {columns.map((column, index) =>
        column.includes('editor') ? (
          <DockSlot key="editor" id="editor" first>
            <Body id="editor" />
          </DockSlot>
        ) : (
          <DockColumn
            key={column.join(' ')}
            column={column}
            side={index < editorAt ? 'right' : 'left'}
            render={(id) => <Body id={id} />}
          />
        )
      )}
    </div>
  )
}

const RECT = { left: 0, top: 0, width: 300, height: 600, right: 300, bottom: 600, x: 0, y: 0 }
const slot = (id: DockPanelId): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-dock-panel="${id}"]`)
  if (!element) throw new Error(`no slot ${id}`)
  element.getBoundingClientRect = () => ({ ...RECT, toJSON: () => RECT })
  return element
}
const dataTransfer = (): Partial<DataTransfer> => ({
  setData: vi.fn(),
  effectAllowed: 'all',
  dropEffect: 'none'
})
/** Starts a drag on `id`'s grip. */
const grab = (id: DockPanelId): void => {
  const label = id === 'editor' ? 'Move Editor' : `Move ${id[0]?.toUpperCase()}${id.slice(1)}`
  fireEvent.dragStart(screen.getByRole('button', { name: label }), { dataTransfer: dataTransfer() })
}
/**
 * Fires a dragover or drop at (`x`, `y`). jsdom has no `DragEvent`, so the coordinates of a
 * `fireEvent` init would be dropped; they are set on the event itself.
 */
const pointer = (type: 'dragOver' | 'drop', element: HTMLElement, x: number, y: number): void => {
  const event = createEvent[type](element, { dataTransfer: dataTransfer() })
  Object.defineProperty(event, 'clientX', { value: x })
  Object.defineProperty(event, 'clientY', { value: y })
  fireEvent(element, event)
}
const columns = (): DockPanelId[][] => useLayoutStore.getState().layout.dock.columns

beforeEach(() => {
  resetLayoutStore()
  resetDockDrag()
  resetPendingSaves()
  // The layout write is debounced; a never-answering client keeps it out of the way.
  setIpcClient({ invoke: () => new Promise(() => {}), on: () => () => {} })
  act(() => {
    useLayoutStore.getState().toggle('notes')
    useLayoutStore.getState().toggle('assistant')
  })
})
afterEach(() => {
  resetLayoutStore()
  resetDockDrag()
  setIpcClient(null)
})

describe('Dock drop zones (layout 3c)', () => {
  it('a drag over a panel’s lower half shows the stack indicator, and the drop stacks it there', () => {
    render(<Screen />)
    grab('assistant')
    expect(useDockDragStore.getState().dragging).toBe('assistant')
    pointer('dragOver', slot('notes'), 150, 500)
    expect(screen.getByTestId('dock-drop-indicator')).toHaveAttribute('data-target', 'after')
    pointer('drop', slot('notes'), 150, 500)
    expect(columns()).toEqual([
      ['sidebar'],
      ['editor'],
      ['notes', 'assistant'],
      ['tags'],
      ['references']
    ])
    expect(useDockDragStore.getState().dragging).toBeNull()
    expect(screen.queryByTestId('dock-drop-indicator')).not.toBeInTheDocument()
    // Both now sit in one column.
    expect(screen.getAllByTestId('dock-column')).toHaveLength(2)
  })

  it('a drop on a panel’s edge strip opens a new column on that side', () => {
    render(<Screen />)
    grab('assistant')
    pointer('dragOver', slot('sidebar'), 5, 300)
    expect(screen.getByTestId('dock-drop-indicator')).toHaveAttribute('data-target', 'left')
    pointer('drop', slot('sidebar'), 5, 300)
    expect(columns()[0]).toEqual(['assistant'])
    expect(columns()[1]).toEqual(['sidebar'])
  })

  it('the editor takes only beside drops: its halves pick the side', () => {
    render(<Screen />)
    grab('notes')
    pointer('dragOver', slot('editor'), 100, 300)
    expect(screen.getByTestId('dock-drop-indicator')).toHaveAttribute('data-target', 'left')
    pointer('drop', slot('editor'), 100, 300)
    expect(columns().slice(0, 3)).toEqual([['sidebar'], ['notes'], ['editor']])
  })

  it('shows no indicator where the drop would change nothing, and ignores drags that are not a panel’s', () => {
    render(<Screen />)
    // Not a panel drag (text, a tree row): nothing happens.
    pointer('dragOver', slot('notes'), 150, 500)
    expect(screen.queryByTestId('dock-drop-indicator')).not.toBeInTheDocument()
    grab('notes')
    pointer('dragOver', slot('notes'), DOCK_EDGE_PX / 2, 300)
    expect(screen.queryByTestId('dock-drop-indicator')).not.toBeInTheDocument()
    const before = columns()
    pointer('drop', slot('notes'), 150, 100)
    expect(columns()).toBe(before)
  })

  it('the grip carries the panel id under the dock’s own drag type', () => {
    render(<Screen />)
    const transfer = dataTransfer()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move Notes' }), {
      dataTransfer: transfer
    })
    expect(transfer.setData).toHaveBeenCalledWith(DOCK_DRAG_TYPE, 'notes')
    fireEvent.dragEnd(screen.getByRole('button', { name: 'Move Notes' }))
    expect(useDockDragStore.getState().dragging).toBeNull()
  })
})

describe('DockPanelControls menu (layout 3c)', () => {
  it('Move left / Move right step the panel and are disabled at the edge; Close closes it', async () => {
    render(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Sidebar panel options' }))
    expect(screen.getByRole('menuitem', { name: 'Move left' })).toBeDisabled()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move right' }))
    expect(columns().slice(0, 2)).toEqual([['editor'], ['sidebar']])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Notes panel options' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close' }))
    expect(useLayoutStore.getState().layout.notes.open).toBe(false)
    expect(screen.queryByTestId('body-notes')).not.toBeInTheDocument()
  })

  it('the editor’s menu has no Close', async () => {
    render(<Screen />)
    await userEvent.click(screen.getByRole('button', { name: 'Editor panel options' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move left',
      'Move right'
    ])
    expect(useLayoutStore.getState().layout.dock).toEqual(defaultLayout().dock)
  })
})
