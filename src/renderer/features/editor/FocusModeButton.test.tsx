import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { FocusModeButton } from './FocusModeButton'

const button = (): HTMLElement => screen.getByRole('button', { name: 'Focus mode' })

let calls: Input<'window:setFullScreen'>[]

beforeEach(() => {
  resetFocusStore()
  calls = []
  // The fake window does what it is asked.
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'window:setFullScreen') throw new Error(`unexpected ${channel}`)
      calls.push(input as Input<'window:setFullScreen'>)
      return input as Output<C>
    },
    on: () => () => {}
  })
})

describe('FocusModeButton (F-6.1)', () => {
  it('names the shortcut and reflects the store with aria-pressed', () => {
    render(<FocusModeButton />)
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(button()).toHaveAttribute('title', 'Focus mode (F11)')
    act(() => useFocusStore.setState({ active: true }))
    expect(button()).toHaveAttribute('aria-pressed', 'true')
  })

  it('toggles focus mode through the store', async () => {
    render(<FocusModeButton />)
    await userEvent.click(button())
    expect(calls).toEqual([{ on: true }])
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button())
    expect(calls).toEqual([{ on: true }, { on: false }])
    expect(button()).toHaveAttribute('aria-pressed', 'false')
  })
})
