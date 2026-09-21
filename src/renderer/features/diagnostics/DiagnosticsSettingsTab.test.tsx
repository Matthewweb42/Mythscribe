import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiagnosticsState } from '@shared/diagnostics'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { DiagnosticsSettingsTab } from './DiagnosticsSettingsTab'
import { resetDiagnosticsStore, useDiagnosticsStore } from './diagnosticsStore'

const PENDING = JSON.stringify(
  {
    appVersion: '0.1.0',
    platform: 'linux',
    arch: 'arm64',
    electron: '38',
    counts: [{ day: '2026-09-20', counter: 'app.launch', n: 3 }],
    crashes: []
  },
  null,
  2
)

const OFF: DiagnosticsState = { enabled: false, pending: PENDING, lastSentDay: null }

let calls: { channel: Channel; input: unknown }[]

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    switch (channel) {
      case 'diagnostics:getState':
        return OFF as Output<C>
      case 'diagnostics:setEnabled':
        return { ...OFF, enabled: (input as { on: boolean }).on } as Output<C>
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const sitting = (state: DiagnosticsState): void => {
  useDiagnosticsStore.setState({ state })
}

beforeEach(() => {
  resetDiagnosticsStore()
  calls = []
  setIpcClient(client)
})
afterEach(() => {
  resetDiagnosticsStore()
})

describe('DiagnosticsSettingsTab (F-15.8)', () => {
  it('asks main for the state it has not got yet, and the switch is off', async () => {
    render(<DiagnosticsSettingsTab />)
    await waitFor(() => {
      expect(calls).toEqual([{ channel: 'diagnostics:getState', input: undefined }])
    })
    expect(screen.getByTestId('diagnostics-enabled')).not.toBeChecked()
  })

  it('says what is sent, what never is, and when the counts go', () => {
    sitting(OFF)
    render(<DiagnosticsSettingsTab />)
    const sent = screen.getByRole('region', { name: 'What is sent' })
    expect(sent).toHaveTextContent('the kind of error')
    expect(sent).toHaveTextContent('lines of the stack that are inside MythScribe')
    expect(sent).toHaveTextContent(
      'the MythScribe version, the Electron version it runs on, your operating system'
    )
    const never = screen.getByRole('region', { name: 'What is never sent' })
    expect(never).toHaveTextContent('Your manuscript, notes, tags')
    expect(never).toHaveTextContent('name of a project, folder, or document')
    expect(never).toHaveTextContent('your email address, or your API key')
    expect(never).toHaveTextContent('no install id')
    expect(screen.getByText(/today’s counts leave after midnight/)).toBeInTheDocument()
  })

  it('turns diagnostics on', async () => {
    sitting(OFF)
    render(<DiagnosticsSettingsTab />)
    await userEvent.click(screen.getByTestId('diagnostics-enabled'))
    expect(calls).toEqual([{ channel: 'diagnostics:setEnabled', input: { on: true } }])
    expect(screen.getByTestId('diagnostics-enabled')).toBeChecked()
  })

  it('shows the next report verbatim, and only when asked', async () => {
    sitting(OFF)
    render(<DiagnosticsSettingsTab />)
    expect(screen.queryByTestId('diagnostics-pending')).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: 'See exactly what would be sent' })
    expect(reveal).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(reveal)
    expect(screen.getByTestId('diagnostics-pending')).toHaveTextContent(
      PENDING.replace(/\s+/g, ' ')
    )
    expect(calls).toEqual([])
    await userEvent.click(reveal)
    expect(screen.queryByTestId('diagnostics-pending')).not.toBeInTheDocument()
  })

  it('says whether anything has been sent from this machine', () => {
    sitting(OFF)
    const { rerender } = render(<DiagnosticsSettingsTab />)
    expect(screen.getByTestId('diagnostics-last-sent')).toHaveTextContent(
      'Nothing has been sent from this machine.'
    )
    sitting({ ...OFF, enabled: true, lastSentDay: '2026-09-20' })
    rerender(<DiagnosticsSettingsTab />)
    expect(screen.getByTestId('diagnostics-last-sent')).toHaveTextContent(
      'Last sent: counts up to 2026-09-20.'
    )
  })

  it('shows a failed switch beside it', () => {
    useDiagnosticsStore.setState({ state: OFF, error: 'Could not write the setting.' })
    render(<DiagnosticsSettingsTab />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not write the setting.')
  })
})
