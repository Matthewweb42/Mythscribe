import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { UpdateState } from '@shared/updates'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { UpdatesSettingsTab } from './UpdatesSettingsTab'
import { resetUpdateStore, useUpdateStore } from './updateStore'

const VERSION = '0.1.0'
const IDLE: UpdateState = {
  currentVersion: VERSION,
  channel: 'stable',
  autoCheck: true,
  status: { state: 'idle' },
  installedNotes: null,
  unseenNotes: false
}

let calls: { channel: Channel; input: unknown }[]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    switch (channel) {
      case 'updates:getState':
        return IDLE as Output<C>
      case 'updates:check':
        return { ...IDLE, status: { state: 'upToDate', checkedAt: NOW } } as Output<C>
      case 'updates:setChannel':
        return { ...IDLE, channel: 'beta' } as Output<C>
      case 'updates:setAutoCheck':
        return { ...IDLE, autoCheck: false } as Output<C>
      case 'updates:markSeen':
        return { ...IDLE, unseenNotes: false } as Output<C>
      // Main quits the app from here; in the test it simply answers.
      case 'updates:install':
        return null as Output<C>
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const NOW = '2026-09-21T10:00:00.000Z'

const sitting = (state: UpdateState): void => {
  useUpdateStore.setState({ state })
}

beforeEach(() => {
  resetUpdateStore()
  calls = []
  setIpcClient(client)
  useProjectStore.setState({ current: null, ready: true, busy: false, recents: [] })
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetUpdateStore()
})

describe('UpdatesSettingsTab (F-15.7)', () => {
  it('shows the running version and asks main for the state it has not got yet', async () => {
    render(<UpdatesSettingsTab />)
    await waitFor(() => {
      expect(calls).toEqual([{ channel: 'updates:getState', input: undefined }])
    })
    expect(screen.getByTestId('update-version')).toHaveTextContent(`MythScribe ${VERSION}`)
    expect(screen.getByTestId('update-status')).toHaveTextContent('No check yet.')
  })

  it('checks on demand and says the app is up to date', async () => {
    sitting(IDLE)
    render(<UpdatesSettingsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(calls).toEqual([{ channel: 'updates:check', input: undefined }])
    expect(screen.getByTestId('update-status')).toHaveTextContent('MythScribe is up to date')
  })

  it('shows the download percent while it runs', () => {
    sitting({ ...IDLE, status: { state: 'downloading', version: '0.2.0', percent: 42 } })
    render(<UpdatesSettingsTab />)
    expect(screen.getByTestId('update-status')).toHaveTextContent('Downloading 0.2.0… 42%')
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  })

  it('shows a failure with its next step', () => {
    sitting({
      ...IDLE,
      status: { state: 'error', message: 'Could not reach GitHub.', nextStep: 'Try again later.' }
    })
    render(<UpdatesSettingsTab />)
    expect(screen.getByTestId('update-status')).toHaveTextContent(
      'Could not reach GitHub. Try again later.'
    )
  })

  it('switches channel, with a sentence about what each one means', async () => {
    sitting(IDLE)
    render(<UpdatesSettingsTab />)
    const stable = screen.getByTestId('update-channel-stable')
    const beta = screen.getByTestId('update-channel-beta')
    expect(stable).toHaveAttribute('aria-checked', 'true')
    expect(beta).toHaveTextContent('rough edges')
    await userEvent.click(beta)
    expect(calls).toEqual([{ channel: 'updates:setChannel', input: { channel: 'beta' } }])
    expect(screen.getByTestId('update-channel-beta')).toHaveAttribute('aria-checked', 'true')
  })

  it('turns the automatic check off and says what it contacts', async () => {
    sitting(IDLE)
    render(<UpdatesSettingsTab />)
    const auto = screen.getByTestId('update-auto-check')
    expect(auto).toBeChecked()
    expect(screen.getByText(/asks GitHub for the list of releases/)).toHaveTextContent(
      'no manuscript text'
    )
    await userEvent.click(auto)
    expect(calls).toEqual([{ channel: 'updates:setAutoCheck', input: { on: false } }])
    expect(screen.getByTestId('update-auto-check')).not.toBeChecked()
  })

  it('offers the notes and a restart when an update is ready, as text and never as markup', async () => {
    sitting({
      ...IDLE,
      status: {
        state: 'ready',
        version: '0.2.0',
        notes: {
          version: '0.2.0',
          date: null,
          text: 'The storm build.\n- Beta reader\n- Faster saves'
        }
      }
    })
    render(<UpdatesSettingsTab />)
    expect(screen.getByTestId('update-status')).toHaveTextContent(
      'Version 0.2.0 is ready to install.'
    )
    const notes = screen.getByTestId('update-ready-notes')
    expect(notes.querySelector('p')).toHaveTextContent('The storm build.')
    expect(
      within(notes)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['Beta reader', 'Faster saves'])
    await userEvent.click(screen.getByTestId('update-install'))
    expect(calls).toEqual([{ channel: 'updates:install', input: undefined }])
  })

  it('shows what is new in the running version once, marking it seen on the way in', async () => {
    sitting({
      ...IDLE,
      installedNotes: { version: VERSION, date: null, text: '- Faster saves' },
      unseenNotes: true
    })
    render(<UpdatesSettingsTab />)
    expect(screen.getByRole('heading', { name: `What's new in ${VERSION}` })).toBeInTheDocument()
    expect(screen.getByTestId('update-whats-new')).toHaveTextContent('Faster saves')
    await waitFor(() => {
      expect(calls).toEqual([{ channel: 'updates:markSeen', input: undefined }])
    })
  })

  it('leaves the notes of a pending version out of "what’s new"', () => {
    sitting({
      ...IDLE,
      installedNotes: { version: '0.2.0', date: null, text: '- Not installed yet' }
    })
    render(<UpdatesSettingsTab />)
    expect(screen.queryByTestId('update-whats-new')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('explains a build that cannot update itself and hides the buttons, keeping the channel', () => {
    sitting({
      ...IDLE,
      status: {
        state: 'unsupported',
        reason: 'This is a development build; updates are installed by the released app.'
      }
    })
    render(<UpdatesSettingsTab />)
    expect(screen.getByTestId('update-status')).toHaveTextContent('This is a development build')
    expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('update-install')).not.toBeInTheDocument()
    expect(screen.getByTestId('update-channel-beta')).toBeEnabled()
  })
})
