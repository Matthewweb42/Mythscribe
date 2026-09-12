import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RESIZE_KEY_STEP_PX, ResizeHandle, type ResizeSide } from './ResizeHandle'

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize it' })

function mount(side: ResizeSide, ariaValue?: (value: number) => number): ReturnType<typeof vi.fn> {
  const onChange = vi.fn()
  render(
    <div className="relative">
      <ResizeHandle
        side={side}
        value={0.22}
        min={0.15}
        max={0.35}
        ariaLabel="Resize it"
        onChange={onChange}
        ariaValue={ariaValue}
      />
    </div>
  )
  return onChange
}

describe('ResizeHandle (F-7.2)', () => {
  it('is a focusable vertical separator reporting whole percents and the hover state', () => {
    mount('right')
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-valuenow', '22')
    expect(handle()).toHaveAttribute('aria-valuemin', '15')
    expect(handle()).toHaveAttribute('aria-valuemax', '35')
    expect(handle()).toHaveAttribute('tabindex', '0')
    expect(handle().className).toContain('hover:bg-accent/40')
    expect(handle().className).toContain('cursor-col-resize')
    expect(handle().className).toContain('-right-1')
    expect(handle().className).not.toContain(' bg-accent/40')
  })

  it('sits on the left edge when asked', () => {
    mount('left')
    expect(handle().className).toContain('-left-1')
    expect(handle().className).not.toContain('-right-1')
  })

  it('a right-edge handle grows its panel when dragged right and shrinks it when dragged left', () => {
    const onChange = mount('right')
    fireEvent.pointerDown(handle(), { clientX: 300, button: 0 })
    expect(handle().className).toContain(' bg-accent/40')
    fireEvent.pointerMove(window, { clientX: 340 })
    expect(onChange).toHaveBeenLastCalledWith(40)
    fireEvent.pointerMove(window, { clientX: 310 })
    expect(onChange).toHaveBeenLastCalledWith(-30)
    expect(onChange).toHaveBeenCalledTimes(2)
    fireEvent.pointerUp(window, { clientX: 310 })
    expect(handle().className).not.toContain(' bg-accent/40')
    // After release, movement no longer reports.
    fireEvent.pointerMove(window, { clientX: 100 })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('a left-edge handle grows its panel when dragged left', () => {
    const onChange = mount('left')
    fireEvent.pointerDown(handle(), { clientX: 600, button: 0 })
    fireEvent.pointerMove(window, { clientX: 550 })
    expect(onChange).toHaveBeenLastCalledWith(50)
    fireEvent.pointerMove(window, { clientX: 640 })
    expect(onChange).toHaveBeenLastCalledWith(-90)
    fireEvent.pointerCancel(window)
    fireEvent.pointerMove(window, { clientX: 100 })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('ignores a pointer move that did not travel and a non-primary button', () => {
    const onChange = mount('right')
    fireEvent.pointerDown(handle(), { clientX: 300, button: 2 })
    fireEvent.pointerMove(window, { clientX: 340 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle(), { clientX: 300, button: 0 })
    fireEvent.pointerMove(window, { clientX: 300 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the arrow keys step by RESIZE_KEY_STEP_PX in the direction of the key', async () => {
    const right = mount('right')
    handle().focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(right).toHaveBeenLastCalledWith(RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowLeft}')
    expect(right).toHaveBeenLastCalledWith(-RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(right).toHaveBeenCalledTimes(2)
  })

  it('on a left-edge handle ArrowLeft grows the panel', async () => {
    const left = mount('left')
    handle().focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(left).toHaveBeenLastCalledWith(RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowRight}')
    expect(left).toHaveBeenLastCalledWith(-RESIZE_KEY_STEP_PX)
  })

  it('formats the ARIA values through ariaValue when given', () => {
    mount('right', (v) => Math.round(v * 1000))
    expect(handle()).toHaveAttribute('aria-valuenow', '220')
    expect(handle()).toHaveAttribute('aria-valuemin', '150')
    expect(handle()).toHaveAttribute('aria-valuemax', '350')
  })
})

describe('ResizeHandle on a top or bottom edge (F-4.4)', () => {
  it('is a horizontal separator with a row cursor on the bottom edge', () => {
    mount('bottom')
    expect(handle()).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle().className).toContain('cursor-row-resize')
    expect(handle().className).toContain('-bottom-1')
    expect(handle().className).toContain('h-2')
    expect(handle().className).not.toContain('cursor-col-resize')
    expect(handle().className).not.toContain('w-2')
  })

  it('sits on the top edge when asked', () => {
    mount('top')
    expect(handle().className).toContain('-top-1')
    expect(handle().className).not.toContain('-bottom-1')
  })

  it('a bottom-edge handle grows its panel when dragged down and ignores x movement', () => {
    const onChange = mount('bottom')
    fireEvent.pointerDown(handle(), { clientX: 10, clientY: 200, button: 0 })
    expect(handle().className).toContain(' bg-accent/40')
    fireEvent.pointerMove(window, { clientX: 500, clientY: 240 })
    expect(onChange).toHaveBeenLastCalledWith(40)
    fireEvent.pointerMove(window, { clientX: 900, clientY: 210 })
    expect(onChange).toHaveBeenLastCalledWith(-30)
    fireEvent.pointerMove(window, { clientX: 100, clientY: 210 })
    expect(onChange).toHaveBeenCalledTimes(2)
    fireEvent.pointerUp(window, { clientY: 210 })
    expect(handle().className).not.toContain(' bg-accent/40')
    fireEvent.pointerMove(window, { clientY: 50 })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('a top-edge handle grows its panel when dragged up', () => {
    const onChange = mount('top')
    fireEvent.pointerDown(handle(), { clientX: 0, clientY: 600, button: 0 })
    fireEvent.pointerMove(window, { clientX: 0, clientY: 550 })
    expect(onChange).toHaveBeenLastCalledWith(50)
    fireEvent.pointerMove(window, { clientX: 0, clientY: 640 })
    expect(onChange).toHaveBeenLastCalledWith(-90)
    fireEvent.pointerCancel(window)
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('ArrowDown grows and ArrowUp shrinks a bottom-edge handle; the horizontal arrows do nothing', async () => {
    const bottom = mount('bottom')
    handle().focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(bottom).toHaveBeenLastCalledWith(RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowUp}')
    expect(bottom).toHaveBeenLastCalledWith(-RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}{Enter}')
    expect(bottom).toHaveBeenCalledTimes(2)
  })

  it('on a top-edge handle ArrowUp grows the panel', async () => {
    const top = mount('top')
    handle().focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(top).toHaveBeenLastCalledWith(RESIZE_KEY_STEP_PX)
    await userEvent.keyboard('{ArrowDown}')
    expect(top).toHaveBeenLastCalledWith(-RESIZE_KEY_STEP_PX)
  })
})
