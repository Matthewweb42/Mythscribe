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
    fireEvent.pointerDown(grip(), { clientX: 420, clientY: 320, button: 0, pointerId: 2 })
    fireEvent.pointerMove(grip(), { clientX: 470, clientY: 350, pointerId: 2 })
    expect(rect()).toEqual({ x: 100, y: 80, width: 370, height: 270 })
    expect(dialog().style.width).toBe('370px')
    expect(dialog().style.height).toBe('270px')
    fireEvent.pointerMove(grip(), { clientX: 0, clientY: 0, pointerId: 2 })
    expect(rect()).toEqual({ x: 100, y: 80, width: 280, height: 200 })
    fireEvent.pointerMove(grip(), { clientX: 3000, clientY: 3000, pointerId: 2 })
    expect(rect()).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    fireEvent.pointerUp(grip(), { clientX: 3000, clientY: 3000, pointerId: 2 })
    fireEvent.pointerMove(grip(), { clientX: 100, clientY: 100, pointerId: 2 })
    expect(rect().width).toBe(1000)
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
