import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Background } from '@shared/focus'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { BackgroundManager } from './BackgroundManager'
import { resetBackgroundStore, useBackgroundStore } from './backgroundStore'

const A: Background = { id: 'a', name: 'a.png', url: 'mythscribe-asset://backgrounds/a.png' }
const B: Background = { id: 'b', name: 'b.jpg', url: 'mythscribe-asset://backgrounds/b.jpg' }

let addAnswer: Output<'background:add'>
let removed: string[]
let onClose: ReturnType<typeof vi.fn<() => void>>

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'background:add') return addAnswer as Output<C>
      if (channel === 'background:remove') {
        removed.push((input as Input<'background:remove'>).id)
        return null as Output<C>
      }
      if (channel === 'focusSettings:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
}

const tile = (name: string): HTMLElement => screen.getByRole('button', { name })

function open(): void {
  render(<BackgroundManager onClose={onClose} />)
}

beforeEach(() => {
  resetBackgroundStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  addAnswer = null
  removed = []
  onClose = vi.fn<() => void>()
  setIpcClient(client())
  useBackgroundStore.setState({ backgrounds: [A, B], settings: { backgroundId: 'b' } })
})
afterEach(() => {
  resetBackgroundStore()
})

describe('BackgroundManager (F-6.2)', () => {
  it('lists "No background" first and the thumbnails, marking the current one', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Backgrounds' })).toBeInTheDocument()
    expect(tile('No background')).toHaveAttribute('aria-pressed', 'false')
    expect(tile('a.png')).toHaveAttribute('aria-pressed', 'false')
    expect(tile('b.jpg')).toHaveAttribute('aria-pressed', 'true')
    const img = tile('a.png').querySelector('img')
    expect(img).toHaveAttribute('src', A.url)
    expect(img).toHaveAttribute('alt', '')
    expect(screen.getByText('2 images')).toBeInTheDocument()
  })

  it('selects a tile and "No background"', async () => {
    open()
    await userEvent.click(tile('a.png'))
    expect(useBackgroundStore.getState().settings).toEqual({ backgroundId: 'a' })
    expect(tile('a.png')).toHaveAttribute('aria-pressed', 'true')
    expect(tile('b.jpg')).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(tile('No background'))
    expect(useBackgroundStore.getState().settings).toEqual({ backgroundId: null })
    expect(tile('No background')).toHaveAttribute('aria-pressed', 'true')
  })

  it('adds the images the dialog answered', async () => {
    open()
    addAnswer = {
      added: [{ id: 'c', name: 'c.webp', url: 'mythscribe-asset://backgrounds/c.webp' }],
      skipped: []
    }
    await userEvent.click(screen.getByRole('button', { name: 'Add images…' }))
    await waitFor(() => expect(tile('c.webp')).toBeInTheDocument())
    expect(screen.getByText('3 images')).toBeInTheDocument()
  })

  it('deletes after confirming and leaves the list alone when cancelled', async () => {
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Delete b.jpg' }))
    expect(useDialogStore.getState().modals).toHaveLength(1)
    act(() => {
      const modal = useDialogStore.getState().modals[0]
      if (modal) useDialogStore.getState().resolveConfirm(modal.id, false)
    })
    await waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(0))
    expect(removed).toEqual([])
    expect(tile('b.jpg')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Delete b.jpg' }))
    const modal = useDialogStore.getState().modals[0]
    expect(modal?.options).toMatchObject({ title: 'Delete "b.jpg"?', danger: true })
    act(() => {
      if (modal) useDialogStore.getState().resolveConfirm(modal.id, true)
    })
    await waitFor(() => expect(removed).toEqual(['b']))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'b.jpg' })).not.toBeInTheDocument()
    )
    // It was the current one, so the selection is back to none.
    expect(tile('No background')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('1 image')).toBeInTheDocument()
  })

  it('closes on Escape without letting the key reach a dialog behind, on X, and on the backdrop', async () => {
    const outer = vi.fn()
    render(
      <div onKeyDown={outer}>
        <BackgroundManager onClose={onClose} />
      </div>
    )
    expect(screen.getByRole('button', { name: 'Close backgrounds' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close backgrounds' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    const backdrop = screen.getByRole('dialog').parentElement
    if (!backdrop) throw new Error('no backdrop')
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(3)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('shows the empty state and disables the tiles until the settings are loaded', () => {
    useBackgroundStore.setState({ backgrounds: [], settings: null })
    open()
    expect(screen.getByText('No images yet.')).toBeInTheDocument()
    expect(tile('No background')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add images…' })).toBeDisabled()
  })
})
