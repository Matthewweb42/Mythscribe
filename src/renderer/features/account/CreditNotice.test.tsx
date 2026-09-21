import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSource } from '@shared/aiSettings'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CreditNotice } from './CreditNotice'
import { resetAccountStore, useAccountStore } from './accountStore'

/**
 * The status-bar warning of the usage meter (F-15.5): who sees it, what it says, and that it
 * opens Settings on the Account tab. The numbers themselves are `@shared/cloudUsage`'s tests.
 */

const DAY_MS = 24 * 60 * 60_000
const SIGNED_IN: AccountStatus = {
  state: 'signedIn',
  email: 'author@example.com',
  userId: 'u-1',
  since: null
}

/** $2.50 left after $0.50 spent over two days: ten days at this pace, so no warning. */
const CREDITS: CreditsResult = {
  balanceMicros: 2_500_000,
  spend: [{ feature: 'ghostText', micros: 500_000, requests: 3, tokens: 900 }],
  periodDays: USAGE_PERIOD_DAYS,
  periodSpend: [{ feature: 'ghostText', micros: 500_000, requests: 3, tokens: 900 }],
  periodFirstChargeAt: Date.now() - 1.5 * DAY_MS,
  packs: []
}

let calls: { channel: Channel; input: unknown }[]
let fail: Error | null

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    if (fail) throw fail
    if (channel === 'account:getCredits') return CREDITS as Output<C>
    throw new Error(`unexpected ${channel}`)
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

beforeEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetShellDialogStore()
  calls = []
  fail = null
  setIpcClient(client)
})
afterEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetShellDialogStore()
})

/** The project's AI source and the account, the two things that decide whether this renders. */
const sitting = (source: AiSource, status: AccountStatus | null, credits?: CreditsResult): void => {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), source } })
  useAccountStore.setState({
    status,
    credits: credits ?? null,
    creditsAt: credits === undefined ? null : Date.now()
  })
}

describe('CreditNotice (F-15.5)', () => {
  it('renders nothing for a project on the author’s own key', () => {
    sitting('ownKey', SIGNED_IN, { ...CREDITS, balanceMicros: 0 })
    render(<CreditNotice />)
    expect(screen.queryByTestId('credit-notice')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('renders nothing while the balance is comfortable', () => {
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<CreditNotice />)
    expect(screen.queryByTestId('credit-notice')).not.toBeInTheDocument()
  })

  it('asks for the credits once, so the warning is there before the first request', async () => {
    sitting('cloud', SIGNED_IN)
    const { rerender } = render(<CreditNotice />)
    await waitFor(() => {
      expect(calls).toEqual([{ channel: 'account:getCredits', input: undefined }])
    })
    rerender(<CreditNotice />)
    expect(calls).toHaveLength(1)
  })

  it('asks for nothing while signed out', () => {
    sitting('cloud', { state: 'signedOut' })
    render(<CreditNotice />)
    expect(calls).toEqual([])
    expect(screen.queryByTestId('credit-notice')).not.toBeInTheDocument()
  })

  it('does not ask again after a failure', async () => {
    fail = new IpcRequestError({ code: 'IO', message: 'Could not reach MythScribe Cloud.' })
    sitting('cloud', SIGNED_IN)
    const { rerender } = render(<CreditNotice />)
    await waitFor(() => {
      expect(useAccountStore.getState().creditsError).toBe('Could not reach MythScribe Cloud.')
    })
    rerender(<CreditNotice />)
    expect(calls).toHaveLength(1)
  })

  it('warns about a low balance and opens Settings on the Account tab', async () => {
    sitting('cloud', SIGNED_IN, { ...CREDITS, balanceMicros: 420_000 })
    render(<CreditNotice />)
    const notice = screen.getByTestId('credit-notice')
    expect(notice).toHaveTextContent('Cloud credits low: $0.42')
    await userEvent.click(notice)
    expect(useShellDialogStore.getState().open).toBe('settings')
    expect(useShellDialogStore.getState().settingsTab).toBe('account')
  })

  it('says when the balance is used up, and when it is days from it', () => {
    sitting('cloud', SIGNED_IN, { ...CREDITS, balanceMicros: 0 })
    const { unmount } = render(<CreditNotice />)
    expect(screen.getByTestId('credit-notice')).toHaveTextContent('Cloud credits used up')
    unmount()

    // $2.50 a day against $5.00 left: two days, inside the three-day warning.
    sitting('cloud', SIGNED_IN, {
      ...CREDITS,
      balanceMicros: 5_000_000,
      periodSpend: [{ feature: 'ghostText', micros: 5_000_000, requests: 9, tokens: 900 }]
    })
    render(<CreditNotice />)
    expect(screen.getByTestId('credit-notice')).toHaveTextContent('Cloud credits: about 2 days left')
  })

  it('follows a balance the store took from a charge', async () => {
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<CreditNotice />)
    expect(screen.queryByTestId('credit-notice')).not.toBeInTheDocument()
    useAccountStore.setState({
      credits: { ...CREDITS, balanceMicros: 900_000 },
      creditsAt: Date.now()
    })
    expect(await screen.findByTestId('credit-notice')).toHaveTextContent('Cloud credits low: $0.90')
  })
})
