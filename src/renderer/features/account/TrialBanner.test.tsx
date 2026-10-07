import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppAccess } from '@shared/appAccess'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetShellDialogStore, useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAppAccessStore, useAppAccessStore, useCanWrite } from './appAccessStore'
import { TRIAL_BANNER_DAYS, TrialBanner } from './TrialBanner'

const ENDS = new Date(2026, 10, 6).toISOString()
const trial = (daysLeft: number): AppAccess => ({ state: 'trial', trialEndsAt: ENDS, daysLeft })
const EXPIRED: AppAccess = { state: 'expired', trialEndsAt: ENDS, daysLeft: 0 }

let pushed: ((access: AppAccess) => void) | null
let calls: Channel[]

beforeEach(() => {
  resetAppAccessStore()
  resetShellDialogStore()
  pushed = null
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel !== 'app:getAccess') throw new Error(`unexpected ${channel}`)
      return trial(30) as Output<C>
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event !== 'app:accessChanged') throw new Error(`unexpected ${event}`)
      pushed = listener as (access: AppAccess) => void
      return () => {
        pushed = null
      }
    }
  }
  setIpcClient(client)
})
afterEach(() => {
  resetAppAccessStore()
  resetShellDialogStore()
})

describe('TrialBanner (AI-BILLING-SPEC M1)', () => {
  it('stays out of the way until the trial has a week left', () => {
    useAppAccessStore.setState({ access: trial(TRIAL_BANNER_DAYS + 1) })
    const { rerender } = render(<TrialBanner />)
    expect(screen.queryByTestId('trial-banner')).not.toBeInTheDocument()
    act(() => useAppAccessStore.setState({ access: trial(TRIAL_BANNER_DAYS) }))
    rerender(<TrialBanner />)
    expect(screen.getByTestId('trial-banner')).toHaveTextContent('7 days left in your trial.')
  })

  it('says the project is read-only after the trial and opens the Account tab to buy', async () => {
    useAppAccessStore.setState({ access: EXPIRED })
    render(<TrialBanner />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your 30-day trial has ended. Projects open read-only; export and backup still work.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Buy MythScribe' }))
    expect(useShellDialogStore.getState()).toMatchObject({
      open: 'settings',
      settingsTab: 'account'
    })
  })

  it('renders nothing with the license or before main has answered', () => {
    const { container, rerender } = render(<TrialBanner />)
    expect(container).toBeEmptyDOMElement()
    act(() =>
      useAppAccessStore.setState({ access: { state: 'licensed', trialEndsAt: ENDS, daysLeft: 0 } })
    )
    rerender(<TrialBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('appAccessStore (AI-BILLING-SPEC M1)', () => {
  function Probe(): React.JSX.Element {
    return <span data-testid="probe">{useCanWrite() ? 'writable' : 'read-only'}</span>
  }

  it('loads from main, follows its pushes, and reads as writable until it knows', async () => {
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('writable')
    const off = useAppAccessStore.getState().subscribe()
    await act(async () => {
      await useAppAccessStore.getState().load()
    })
    expect(calls).toEqual(['app:getAccess'])
    expect(useAppAccessStore.getState().access).toEqual(trial(30))
    act(() => pushed?.(EXPIRED))
    expect(screen.getByTestId('probe')).toHaveTextContent('read-only')
    off()
    expect(pushed).toBeNull()
  })
})
