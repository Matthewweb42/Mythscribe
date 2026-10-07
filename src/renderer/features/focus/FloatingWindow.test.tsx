import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { FLOATING_KEY_STEP_PX, type Rect } from '@shared/layout'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import {
  LAYOUT_SAVE_DELAY_MS,
  resetLayoutStore,
  useLayoutStore
} from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { FloatingWindow } from './FloatingWindow'

const writes: Input<'layout:set'>[] = []
const onClose = vi.fn()

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    if (channel === 'layout:set') {
      writes.push(input as Input<'layout:set'>)
      return input as Output<C>
    }
    throw new Error(`unexpected ${channel}`)
  },
  on: () => () => {}
}

const START: Rect = { x: 100, y: 80, width: 320, height: 240 }

const rect = (): Rect => useLayoutStore.getState().layout.floating.notes
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Notes' })
const titleBar = (): HTMLElement => screen.getByRole('group', { name: 'Notes window' })
const grip = (): HTMLElement => screen.getByTestId('floating-notes-grip')
const handle = (edge: string): HTMLElement => screen.getByTestId(`floating-notes-resize-${edge}`)

function mount(children: React.ReactNode = <p>body</p>): void {
  render(
    <FloatingWindow name="notes" title="Notes" onClose={onClose}>
      {children}
    </FloatingWindow>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  resetLayoutStore()
  resetPendingSaves()
  writes.length = 0
  onClose.mockClear()
  setIpcClient(client)
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
  useLayoutStore.setState({
    layout: {
      ...useLayoutStore.getState().layout,
      floating: { ...useLayoutStore.getState().layout.floating, notes: { ...START } }
    }
  })
})
afterEach(() => {
  resetLayoutStore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('FloatingWindow (F-6.6)', () => {
  it('is a non-modal dialog placed and sized from the layout, with a title bar, Close, and a grip', () => {
    mount(<p>the body</p>)
    const window = dialog()
    expect(window).toHaveAttribute('data-testid', 'floating-notes')
    expect(window).not.toHaveAttribute('aria-modal')
    expect(window.style.left).toBe('100px')
    expect(window.style.top).toBe('80px')
    expect(window.style.width).toBe('320px')
    expect(window.style.height).toBe('240px')
    expect(titleBar()).toHaveAttribute('tabindex', '0')
    expect(titleBar()).toHaveTextContent('Notes')
    expect(screen.getByRole('button', { name: 'Close Notes' })).toBeInTheDocument()
    expect(grip()).toHaveAttribute('aria-hidden', 'true')
    expect(window).toHaveTextContent('the body')
  })

  it('renders the extra actions in the title bar', () => {
    render(
      <FloatingWindow
        name="notes"
        title="Notes"
        onClose={onClose}
        actions={<button type="button">Extra</button>}
      >
        <p>body</p>
      </FloatingWindow>
    )
    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument()
  })

  it('dragging the title bar moves the window by the pointer deltas and writes once', async () => {
    mount()
    fireEvent.pointerDown(titleBar(), { clientX: 200, clientY: 100, button: 0, pointerId: 1 })
    expect(titleBar().className).toContain('cursor-grabbing')
    fireEvent.pointerMove(titleBar(), { clientX: 240, clientY: 130, pointerId: 1 })
    expect(rect()).toEqual({ x: 140, y: 110, width: 320, height: 240 })
    fireEvent.pointerMove(titleBar(), { clientX: 230, clientY: 130, pointerId: 1 })
    expect(rect()).toEqual({ x: 130, y: 110, width: 320, height: 240 })
    expect(dialog().style.left).toBe('130px')
    expect(dialog().style.top).toBe('110px')
    fireEvent.pointerUp(titleBar(), { clientX: 230, clientY: 130, pointerId: 1 })
    expect(titleBar().className).toContain('cursor-grab')
    // Released: further movement does nothing.
    fireEvent.pointerMove(titleBar(), { clientX: 500, clientY: 500, pointerId: 1 })
    expect(rect().x).toBe(130)
    await act(() => vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.floating.notes).toEqual({ x: 130, y: 110, width: 320, height: 240 })
  })

  it('measures a drag from its origin, so sub-pixel pointer steps lose nothing to rounding', () => {
    mount()
    fireEvent.pointerDown(grip(), { clientX: 420, clientY: 320, button: 0, pointerId: 2 })
    for (let step = 1; step <= 6; step += 1) {
      fireEvent.pointerMove(grip(), {
        clientX: 420 - (40 * step) / 6,
        clientY: 320 + (30 * step) / 6,
        pointerId: 2
      })
    }
    expect(rect()).toEqual({ x: 100, y: 80, width: 280, height: 270 })
    fireEvent.pointerUp(grip(), { clientX: 380, clientY: 350, pointerId: 2 })
    fireEvent.pointerDown(titleBar(), { clientX: 200, clientY: 100, button: 0, pointerId: 1 })
    for (let step = 1; step <= 6; step += 1) {
      fireEvent.pointerMove(titleBar(), {
        clientX: 200 + (40 * step) / 6,
        clientY: 100 - (20 * step) / 6,
        pointerId: 1
      })
    }
    expect(rect()).toEqual({ x: 140, y: 60, width: 280, height: 270 })
  })

  it('a secondary button does not start a drag', () => {
    mount()
    fireEvent.pointerDown(titleBar(), { clientX: 200, clientY: 100, button: 2, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 300, clientY: 200, pointerId: 1 })
    expect(rect()).toEqual(START)
  })

  it('the drag is clamped so the window stays inside the viewport', () => {
    mount()
    fireEvent.pointerDown(titleBar(), { clientX: 200, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerMove(titleBar(), { clientX: 2000, clientY: 2000, pointerId: 1 })
    expect(rect()).toEqual({ x: 680, y: 560, width: 320, height: 240 })
    fireEvent.pointerMove(titleBar(), { clientX: -2000, clientY: -2000, pointerId: 1 })
    expect(rect()).toEqual({ x: 0, y: 0, width: 320, height: 240 })
  })

  it('dragging the grip resizes the window, never under the minimum or past the viewport', () => {
    mount()
    expect(grip().querySelector('svg')).not.toBeNull()
    fireEvent.pointerDown(grip(), { clientX: 420, clientY: 320, button: 0, pointerId: 2 })
    fireEvent.pointerMove(grip(), { clientX: 470, clientY: 350, pointerId: 2 })
    expect(rect()).toEqual({ x: 100, y: 80, width: 370, height: 270 })
    expect(dialog().style.width).toBe('370px')
    expect(dialog().style.height).toBe('270px')
    fireEvent.pointerMove(grip(), { clientX: 0, clientY: 0, pointerId: 2 })
    expect(rect()).toEqual({ x: 100, y: 80, width: 280, height: 200 })
    // Past the viewport the bottom-right edges stop at it; the top-left corner stays put.
    fireEvent.pointerMove(grip(), { clientX: 3000, clientY: 3000, pointerId: 2 })
    expect(rect()).toEqual({ x: 100, y: 80, width: 900, height: 720 })
    fireEvent.pointerUp(grip(), { clientX: 3000, clientY: 3000, pointerId: 2 })
    fireEvent.pointerMove(grip(), { clientX: 100, clientY: 100, pointerId: 2 })
    expect(rect().width).toBe(900)
  })

  it('has a resize handle on every edge and corner, each with its own cursor', () => {
    mount()
    const cursors: Record<string, string> = {
      n: 'cursor-ns-resize',
      s: 'cursor-ns-resize',
      e: 'cursor-ew-resize',
      w: 'cursor-ew-resize',
      ne: 'cursor-nesw-resize',
      sw: 'cursor-nesw-resize',
      nw: 'cursor-nwse-resize'
    }
    for (const [edge, cursor] of Object.entries(cursors)) {
      expect(handle(edge), edge).toHaveAttribute('aria-hidden', 'true')
      expect(handle(edge).className, edge).toContain(cursor)
    }
    expect(grip().className).toContain('cursor-nwse-resize')
    expect(dialog().querySelectorAll('[data-edge]')).toHaveLength(8)
  })

  it('dragging the left edge moves the left side only, stopping at the minimum and the viewport', async () => {
    mount()
    fireEvent.pointerDown(handle('w'), { clientX: 100, clientY: 200, button: 0, pointerId: 3 })
    fireEvent.pointerMove(handle('w'), { clientX: 60, clientY: 260, pointerId: 3 })
    expect(rect()).toEqual({ x: 60, y: 80, width: 360, height: 240 })
    expect(handle('w').className).toContain('bg-accent/40')
    // Past the minimum: the right edge (420) stays where it was.
    fireEvent.pointerMove(handle('w'), { clientX: 400, clientY: 200, pointerId: 3 })
    expect(rect()).toEqual({ x: 140, y: 80, width: 280, height: 240 })
    // Past the screen's left edge: it stops at 0, never pushing the right edge out.
    fireEvent.pointerMove(handle('w'), { clientX: -500, clientY: 200, pointerId: 3 })
    expect(rect()).toEqual({ x: 0, y: 80, width: 420, height: 240 })
    fireEvent.pointerUp(handle('w'), { clientX: -500, clientY: 200, pointerId: 3 })
    await act(() => vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.floating.notes).toEqual({ x: 0, y: 80, width: 420, height: 240 })
  })

  it('dragging the top-left corner moves the top and left sides together', () => {
    mount()
    fireEvent.pointerDown(handle('nw'), { clientX: 100, clientY: 80, button: 0, pointerId: 4 })
    fireEvent.pointerMove(handle('nw'), { clientX: 70, clientY: 40, pointerId: 4 })
    expect(rect()).toEqual({ x: 70, y: 40, width: 350, height: 280 })
    fireEvent.pointerUp(handle('nw'), { clientX: 70, clientY: 40, pointerId: 4 })
    // The other corners and edges follow the same rule.
    fireEvent.pointerDown(handle('ne'), { clientX: 420, clientY: 40, button: 0, pointerId: 5 })
    fireEvent.pointerMove(handle('ne'), { clientX: 440, clientY: 60, pointerId: 5 })
    expect(rect()).toEqual({ x: 70, y: 60, width: 370, height: 260 })
    fireEvent.pointerUp(handle('ne'), { clientX: 440, clientY: 60, pointerId: 5 })
    fireEvent.pointerDown(handle('s'), { clientX: 200, clientY: 320, button: 0, pointerId: 6 })
    fireEvent.pointerMove(handle('s'), { clientX: 260, clientY: 340, pointerId: 6 })
    expect(rect()).toEqual({ x: 70, y: 60, width: 370, height: 280 })
    fireEvent.pointerUp(handle('s'), { clientX: 260, clientY: 340, pointerId: 6 })
    // A secondary button starts nothing.
    fireEvent.pointerDown(handle('n'), { clientX: 200, clientY: 60, button: 2, pointerId: 7 })
    fireEvent.pointerMove(handle('n'), { clientX: 200, clientY: 0, pointerId: 7 })
    expect(rect()).toEqual({ x: 70, y: 60, width: 370, height: 280 })
  })

  it('arrow keys on the focused title bar move it by the key step; Shift+arrows resize it', async () => {
    mount()
    titleBar().focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(rect()).toEqual({ ...START, x: 100 + FLOATING_KEY_STEP_PX })
    await userEvent.keyboard('{ArrowDown}{ArrowLeft}{ArrowUp}')
    expect(rect()).toEqual(START)
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}')
    expect(rect()).toEqual({
      ...START,
      width: 320 + FLOATING_KEY_STEP_PX,
      height: 240 + FLOATING_KEY_STEP_PX
    })
    await userEvent.keyboard('{Shift>}{ArrowLeft}{ArrowUp}{/Shift}')
    expect(rect()).toEqual(START)
    // Other keys are left alone.
    await userEvent.keyboard('{Home}')
    expect(rect()).toEqual(START)
  })

  it('Close calls onClose; Escape anywhere inside closes without reaching the document', async () => {
    mount(<input aria-label="Inside" />)
    await userEvent.click(screen.getByRole('button', { name: 'Close Notes' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    const seen: KeyboardEvent[] = []
    const listener = (event: KeyboardEvent): void => {
      seen.push(event)
    }
    document.addEventListener('keydown', listener)
    try {
      const inside = screen.getByRole('textbox', { name: 'Inside' })
      inside.focus()
      fireEvent.keyDown(inside, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(2)
      expect(seen).toHaveLength(0)
      // A different key propagates as usual.
      fireEvent.keyDown(inside, { key: 'a' })
      expect(seen).toHaveLength(1)
      expect(onClose).toHaveBeenCalledTimes(2)
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('re-clamps a stored rect into the viewport on mount and when the window shrinks', async () => {
    useLayoutStore.setState({
      layout: {
        ...useLayoutStore.getState().layout,
        floating: {
          ...useLayoutStore.getState().layout.floating,
          notes: { x: 900, y: 700, width: 320, height: 240 }
        }
      }
    })
    mount()
    expect(rect()).toEqual({ x: 680, y: 560, width: 320, height: 240 })
    vi.stubGlobal('innerWidth', 600)
    vi.stubGlobal('innerHeight', 400)
    fireEvent(window, new Event('resize'))
    expect(rect()).toEqual({ x: 280, y: 160, width: 320, height: 240 })
    await act(() => vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.floating.notes).toEqual({ x: 280, y: 160, width: 320, height: 240 })
  })

  it('a rect that already fits is left alone on mount, with no write', async () => {
    mount()
    expect(rect()).toEqual(START)
    await act(() => vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DELAY_MS))
    expect(writes).toHaveLength(0)
  })
})
