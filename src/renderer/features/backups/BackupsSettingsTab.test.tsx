import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultBackupSettings, type BackupState } from '@shared/backups'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  Output,
  ProjectInfo
} from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { BackupsSettingsTab } from './BackupsSettingsTab'
import { resetBackupStore } from './backupStore'

const project: ProjectInfo = {
  id: '0123456789',
  name: 'Ridge',
  format: 'novel',
  path: '/books/Ridge.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

const ENTRY = {
  file: '/backups/Ridge (01234567)/Ridge 2026-10-04 120000.zip',
  name: 'Ridge 2026-10-04 120000.zip',
  createdAt: '2026-10-04T12:00:00.000Z',
  bytes: 2.5 * 1024 * 1024
}

const BASE: BackupState = {
  settings: defaultBackupSettings(),
  folder: '/home/me/Documents/MythScribe Backups',
  defaultFolder: '/home/me/Documents/MythScribe Backups',
  backups: [ENTRY],
  lastBackupAt: ENTRY.createdAt,
  lastError: null
}

let state: BackupState
let calls: { channel: Channel; input: unknown }[]
let restoreFails: boolean

const restored: ProjectInfo = {
  ...project,
  path: '/books/Ridge (restored 2026-10-04 1300).mythscribe'
}

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    switch (channel) {
      case 'backups:get':
        return state as Output<C>
      case 'backups:setSettings': {
        const { patch } = input as Input<'backups:setSettings'>
        state = {
          ...state,
          settings: {
            ...state.settings,
            enabled: patch.enabled ?? state.settings.enabled,
            intervalMinutes: patch.intervalMinutes ?? state.settings.intervalMinutes,
            keep: patch.keep ?? state.settings.keep
          }
        }
        return state as Output<C>
      }
      case 'backups:now':
        return state as Output<C>
      case 'backups:restore':
        if (restoreFails) throw new Error('This file is not a MythScribe backup')
        return restored as Output<C>
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const channels = (): Channel[] => calls.map((c) => c.channel)

beforeEach(() => {
  resetBackupStore()
  resetPendingSaves()
  resetShellDialogStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useProjectStore.setState({ current: project, busy: false })
  state = BASE
  calls = []
  restoreFails = false
  setIpcClient(client)
})
afterEach(() => {
  resetBackupStore()
  resetShellDialogStore()
  useProjectStore.setState({ current: null, busy: false })
})

describe('BackupsSettingsTab (F-8.4)', () => {
  it("shows the settings, the folder, the cloud-folder hint, and the project's backups", async () => {
    render(<BackupsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('backups-enabled')).toBeChecked())
    expect(screen.getByTestId('backups-interval')).toHaveValue('30')
    expect(screen.getByTestId('backups-on-close')).toBeChecked()
    expect(screen.getByTestId('backups-keep')).toHaveValue('10')
    expect(screen.getByTestId('backups-folder')).toHaveTextContent('MythScribe Backups')
    expect(screen.getByText(/Dropbox, OneDrive, iCloud Drive, or Google Drive/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use default' })).toBeDisabled()
    const rows = screen.getAllByTestId('backup-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('2.5 MB')
  })

  it('forwards the switch, the interval, and the retention', async () => {
    render(<BackupsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('backups-enabled')).toBeEnabled())
    await userEvent.selectOptions(screen.getByTestId('backups-interval'), 'Every hour')
    await userEvent.selectOptions(screen.getByTestId('backups-keep'), '20')
    await userEvent.click(screen.getByTestId('backups-enabled'))
    expect(calls.filter((c) => c.channel === 'backups:setSettings').map((c) => c.input)).toEqual([
      { patch: { intervalMinutes: 60 } },
      { patch: { keep: 20 } },
      { patch: { enabled: false } }
    ])
    await waitFor(() => expect(screen.getByTestId('backups-interval')).toBeDisabled())
  })

  it('backs up now only with a project open', async () => {
    useProjectStore.setState({ current: null })
    const { unmount } = render(<BackupsSettingsTab />)
    await waitFor(() => expect(screen.getByTestId('backups-enabled')).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    expect(screen.getByText('Open a project to see its backups.')).toBeInTheDocument()
    unmount()

    useProjectStore.setState({ current: project })
    render(<BackupsSettingsTab />)
    const now = screen.getByRole('button', { name: 'Back up now' })
    await waitFor(() => expect(now).toBeEnabled())
    await userEvent.click(now)
    await waitFor(() => expect(channels()).toContain('backups:now'))
  })

  it('restores a listed backup as a copy after confirming, and closes Settings', async () => {
    useShellDialogStore.getState().show('settings', 'backups')
    render(
      <>
        <BackupsSettingsTab />
        <DialogHost />
      </>
    )
    const row = (await screen.findAllByTestId('backup-row'))[0]
    if (row === undefined) throw new Error('no row')
    await userEvent.click(within(row).getByRole('button', { name: /Restore the backup from/ }))
    const confirm = await screen.findByRole('dialog', { name: 'Restore as a copy?' })
    expect(confirm).toHaveTextContent('Nothing is overwritten')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(useProjectStore.getState().current).toEqual(restored))
    expect(calls.find((c) => c.channel === 'backups:restore')?.input).toEqual({ file: ENTRY.file })
    expect(useShellDialogStore.getState().open).toBeNull()
  })

  it('does nothing when the confirm is cancelled', async () => {
    render(
      <>
        <BackupsSettingsTab />
        <DialogHost />
      </>
    )
    const row = (await screen.findAllByTestId('backup-row'))[0]
    if (row === undefined) throw new Error('no row')
    await userEvent.click(within(row).getByRole('button', { name: /Restore the backup from/ }))
    const confirm = await screen.findByRole('dialog', { name: 'Restore as a copy?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(channels()).not.toContain('backups:restore')
  })

  it('restores from a file and shows why one was refused', async () => {
    restoreFails = true
    render(<BackupsSettingsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Restore from a backup file…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is not a MythScribe backup'
    )
    expect(calls.find((c) => c.channel === 'backups:restore')?.input).toEqual({ file: undefined })
    expect(useProjectStore.getState().current).toEqual(project)
  })

  it('shows the last automatic failure', async () => {
    state = { ...BASE, lastError: 'EACCES: permission denied' }
    render(<BackupsSettingsTab />)
    expect(await screen.findByTestId('backups-last-error')).toHaveTextContent(
      'The last automatic backup failed: EACCES: permission denied'
    )
  })
})
