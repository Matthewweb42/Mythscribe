import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ABOUT_TAGLINE, AboutDialog } from './AboutDialog'

function install(info: { version: string; platform: string } | Error): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      if (channel === 'app:info') {
        if (info instanceof Error) throw info
        return info as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'About MythScribe' })

beforeEach(() => {
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('AboutDialog (F-7.1)', () => {
  it('shows the mark, the version main reports, and the tagline, with OK focused', async () => {
    install({ version: '1.2.3', platform: 'linux' })
    render(<AboutDialog onClose={vi.fn()} />)
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('img', { name: 'MythScribe' })).toBeInTheDocument()
    expect(screen.getByTestId('about-version')).toHaveTextContent('Version …')
    await waitFor(() =>
      expect(screen.getByTestId('about-version')).toHaveTextContent('Version 1.2.3')
    )
    expect(screen.getByText(ABOUT_TAGLINE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
  })

  it('closes on OK, Escape, and a backdrop click', async () => {
    install({ version: '1.2.3', platform: 'linux' })
    const onClose = vi.fn()
    render(<AboutDialog onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(dialog().parentElement!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('toasts when the version cannot be read and keeps the placeholder', async () => {
    install(new Error('no bridge'))
    render(<AboutDialog onClose={vi.fn()} />)
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['no bridge'])
    )
    expect(screen.getByTestId('about-version')).toHaveTextContent('Version …')
  })
})
