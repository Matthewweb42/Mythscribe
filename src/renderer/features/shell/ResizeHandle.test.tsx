import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RESIZE_KEY_STEP_PX, ResizeHandle } from './ResizeHandle'

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize it' })

function mount(side: 'left' | 'right'): ReturnType<typeof vi.fn> {
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
})
