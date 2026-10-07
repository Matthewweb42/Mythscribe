import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSource } from '@shared/aiSettings'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult, PricingResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import { bundledPricing } from '@shared/hostedPricing'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { BalanceNotice } from './BalanceNotice'
import { resetAccountStore, useAccountStore } from './accountStore'

/**
 * The balance in the status bar (F-15.5; AI-BILLING-SPEC E1, E2, E6): who sees it, what it says,
 * when it turns into a warning, and that it opens Settings on the Account tab. The numbers
 * themselves are `@shared/cloudUsage`'s and `@shared/hostedPricing`'s tests.
 */

const DAY_MS = 24 * 60 * 60_000
const SIGNED_IN: AccountStatus = {
  state: 'signedIn',
  email: 'author@example.com',
  userId: 'u-1',
  since: null
}

/** $2.50 left after $0.50 spent over two days: ten days at this pace, above the $2.00 line. */
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
let pricing: PricingResult | null

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    if (channel === 'account:getPricing') return pricing as Output<C>
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
  pricing = null
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

const creditCalls = (): unknown[] => calls.filter((call) => call.channel === 'account:getCredits')

describe('BalanceNotice (F-15.5, AI-BILLING-SPEC E1)', () => {
  it('renders nothing for a project on the author’s own key', () => {
    sitting('ownKey', SIGNED_IN, { ...CREDITS, balanceMicros: 0 })
    render(<BalanceNotice cloudAvailable />)
    expect(screen.queryByTestId('balance-notice')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('always shows the balance in dollars on Cloud, quietly while it is comfortable', () => {
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<BalanceNotice cloudAvailable />)
    const notice = screen.getByTestId('balance-notice')
    expect(notice).toHaveTextContent('Balance $2.50')
    expect(notice).not.toHaveAttribute('data-warning')
    expect(notice.textContent).not.toMatch(/credit|token/i)
  })

  it('asks for the balance once, so it is there before the first request', async () => {
    sitting('cloud', SIGNED_IN)
    const { rerender } = render(<BalanceNotice cloudAvailable />)
    await waitFor(() => {
      expect(creditCalls()).toEqual([{ channel: 'account:getCredits', input: undefined }])
    })
    rerender(<BalanceNotice cloudAvailable />)
    expect(creditCalls()).toHaveLength(1)
  })

  it('asks for nothing while signed out', () => {
    sitting('cloud', { state: 'signedOut' })
    render(<BalanceNotice cloudAvailable />)
    expect(calls).toEqual([])
    expect(screen.queryByTestId('balance-notice')).not.toBeInTheDocument()
  })

  it('does not ask again after a failure', async () => {
    fail = new IpcRequestError({ code: 'IO', message: 'Could not reach MythScribe Cloud.' })
    sitting('cloud', SIGNED_IN)
    const { rerender } = render(<BalanceNotice cloudAvailable />)
    await waitFor(() => {
      expect(useAccountStore.getState().creditsError).toBe('Could not reach MythScribe Cloud.')
    })
    rerender(<BalanceNotice cloudAvailable />)
    expect(creditCalls()).toHaveLength(1)
  })

  it('warns below the $2.00 default line and opens Settings on the Account tab', async () => {
    sitting('cloud', SIGNED_IN, { ...CREDITS, balanceMicros: 1_420_000 })
    render(<BalanceNotice cloudAvailable />)
    const notice = screen.getByTestId('balance-notice')
    expect(notice).toHaveTextContent('MythScribe Cloud balance low: $1.42')
    expect(notice).toHaveAttribute('data-warning', 'low')
    await userEvent.click(notice)
    expect(useShellDialogStore.getState().open).toBe('settings')
    expect(useShellDialogStore.getState().settingsTab).toBe('account')
  })

  it('warns at the line the server configured (E6)', async () => {
    pricing = { ...bundledPricing(), lowBalanceWarningMicros: 3_000_000 }
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<BalanceNotice cloudAvailable />)
    expect(await screen.findByText('MythScribe Cloud balance low: $2.50')).toBeInTheDocument()
  })

  it('shows the words of line editing left once measured (E2)', async () => {
    pricing = { ...bundledPricing(), wordCosts: { lineEdit: 0.00005, consistencyCheck: null } }
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<BalanceNotice cloudAvailable />)
    // $2.50 / ($0.00005 × 1.2) = 41,666 words → 41,000.
    await waitFor(() => {
      expect(screen.getByTestId('balance-notice')).toHaveAttribute(
        'title',
        'About 41,000 words of line editing left'
      )
    })
  })

  it('says when the balance is used up, and when it is days from it', () => {
    sitting('cloud', SIGNED_IN, { ...CREDITS, balanceMicros: 0 })
    const { unmount } = render(<BalanceNotice cloudAvailable />)
    expect(screen.getByTestId('balance-notice')).toHaveTextContent(
      'MythScribe Cloud balance used up'
    )
    unmount()

    // $2.50 a day against $5.00 left: two days, inside the three-day warning.
    sitting('cloud', SIGNED_IN, {
      ...CREDITS,
      balanceMicros: 5_000_000,
      periodSpend: [{ feature: 'ghostText', micros: 5_000_000, requests: 9, tokens: 900 }]
    })
    render(<BalanceNotice cloudAvailable />)
    expect(screen.getByTestId('balance-notice')).toHaveTextContent(
      'MythScribe Cloud balance: about 2 days left'
    )
  })

  it('renders and asks for nothing while Cloud does not serve AI yet', () => {
    sitting('cloud', SIGNED_IN, { ...CREDITS, balanceMicros: 0 })
    render(<BalanceNotice />)
    expect(screen.queryByTestId('balance-notice')).not.toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('follows a balance the store took from a charge', async () => {
    sitting('cloud', SIGNED_IN, CREDITS)
    render(<BalanceNotice cloudAvailable />)
    expect(screen.getByTestId('balance-notice')).toHaveTextContent('Balance $2.50')
    useAccountStore.setState({
      credits: { ...CREDITS, balanceMicros: 900_000 },
      creditsAt: Date.now()
    })
    expect(await screen.findByText('MythScribe Cloud balance low: $0.90')).toBeInTheDocument()
  })
})
