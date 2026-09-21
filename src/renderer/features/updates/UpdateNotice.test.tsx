import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { UpdateNotice } from './UpdateNotice'
import { resetUpdateStore, useUpdateStore } from './updateStore'

const IDLE: UpdateState = {
  currentVersion: '0.1.0',
  channel: 'stable',
  autoCheck: true,
  status: { state: 'idle' },
  installedNotes: null,
  unseenNotes: false
}

beforeEach(() => {
  resetUpdateStore()
  resetShellDialogStore()
})
afterEach(() => {
  resetUpdateStore()
  resetShellDialogStore()
})

describe('UpdateNotice (F-15.7)', () => {
  it('renders nothing before the state is known, and nothing while there is no news', () => {
    const { rerender } = render(<UpdateNotice />)
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument()
    useUpdateStore.setState({ state: { ...IDLE, status: { state: 'checking' } } })
    rerender(<UpdateNotice />)
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument()
  })

  it('offers the restart when an update is downloaded and waiting', async () => {
    useUpdateStore.setState({
      state: {
        ...IDLE,
        status: {
          state: 'ready',
          version: '0.2.0',
          notes: { version: '0.2.0', date: null, text: '- Faster' }
        }
      }
    })
    render(<UpdateNotice />)
    const notice = screen.getByTestId('update-notice')
    expect(notice).toHaveTextContent('Update ready — restart to install')
    await userEvent.click(notice)
    expect(useShellDialogStore.getState().open).toBe('settings')
    expect(useShellDialogStore.getState().settingsTab).toBe('updates')
  })

  it('points at what is new after an update, until the notes have been seen', () => {
    useUpdateStore.setState({
      state: {
        ...IDLE,
        installedNotes: { version: '0.1.0', date: null, text: '- Faster' },
        unseenNotes: true
      }
    })
    const { rerender } = render(<UpdateNotice />)
    expect(screen.getByTestId('update-notice')).toHaveTextContent("What's new in 0.1.0")
    useUpdateStore.setState({ state: { ...IDLE, unseenNotes: false } })
    rerender(<UpdateNotice />)
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument()
  })
})
