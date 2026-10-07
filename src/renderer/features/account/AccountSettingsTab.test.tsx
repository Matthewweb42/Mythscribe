import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult, PricingResult, UsageResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import { bundledPricing } from '@shared/hostedPricing'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { SupporterStatus } from '@shared/license'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { AccountSettingsTab } from './AccountSettingsTab'
import { resetAccountStore, useAccountStore } from './accountStore'

const SIGNED_OUT: AccountStatus = { state: 'signedOut' }
const PENDING: AccountStatus = {
  state: 'pending',
  email: 'author@example.com',
  attemptId: 'att-1',
  expiresAt: new Date(2026, 8, 19, 12, 15).toISOString()
}
const SIGNED_IN: AccountStatus = {
  state: 'signedIn',
  email: 'author@example.com',
  userId: 'u-1',
  since: new Date(2026, 8, 19, 12, 0).toISOString()
}

const DAY_MS = 24 * 60 * 60_000
const CREDITS: CreditsResult = {
  balanceMicros: 2_500_000,
  spend: [
    { feature: 'ghostText', micros: 1200, requests: 3, tokens: 900 },
    { feature: 'chat', micros: 300, requests: 1, tokens: 400 }
  ],
  periodDays: USAGE_PERIOD_DAYS,
  // 0.50 USD over two days (a day and a half, rounded up) is 0.25 a day, so 2.50 lasts ten.
  periodSpend: [{ feature: 'ghostText', micros: 500_000, requests: 3, tokens: 900 }],
  periodFirstChargeAt: Date.now() - 1.5 * DAY_MS,
  packs: [
    { variantId: 'pack-5', priceCents: 500 },
    { variantId: 'pack-10', priceCents: 1000 },
    { variantId: 'pack-25', priceCents: 2500 },
    { variantId: 'pack-50', priceCents: 5000 }
  ]
}

/** E7: two pages of the account's ledger, newest first. */
const USAGE_PAGES: Record<string, UsageResult> = {
  first: {
    entries: [
      {
        id: 'e2',
        type: 'charge',
        amountMicros: -1_300,
        at: Date.UTC(2026, 9, 7, 10),
        feature: 'chat',
        model: 'deepseek/deepseek-v4-flash',
        tokensIn: 1_200,
        tokensOut: 300,
        tokensCached: 0,
        requestId: 'r2'
      },
      {
        id: 'e1',
        type: 'topup',
        amountMicros: 10_000_000,
        at: Date.UTC(2026, 9, 6, 10),
        feature: null,
        model: null,
        tokensIn: null,
        tokensOut: null,
        tokensCached: null,
        requestId: null
      }
    ],
    nextCursor: 'page-2'
  },
  'page-2': {
    entries: [
      {
        id: 'e0',
        type: 'trial_grant',
        amountMicros: 2_000_000,
        at: Date.UTC(2026, 9, 5, 10),
        feature: null,
        model: null,
        tokensIn: null,
        tokensOut: null,
        tokensCached: null,
        requestId: null
      }
    ],
    nextCursor: null
  }
}

/** F-15.9: no license, with the one-time product on sale. */
const UNLICENSED: SupporterStatus = {
  licensed: false,
  since: null,
  validUntil: null,
  offline: false,
  product: { variantId: 'supporter-39', priceCents: 3900 },
  accent: 'default'
}
const LICENSED: SupporterStatus = {
  licensed: true,
  since: new Date(2026, 8, 20, 10, 0).toISOString(),
  validUntil: new Date(2026, 9, 4, 10, 0).toISOString(),
  offline: false,
  product: null,
  accent: 'ember'
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  listener: ((status: AccountStatus) => void) | null
  /** Thrown by every channel while set. */
  fail: Error | null
  /**
   * `account:getPricing` answers this and is counted apart from `calls`: the table is read quietly
   * beside every balance load, and the call lists below are about the account channels.
   */
  pricing: PricingResult | null
  pricingCalls: number
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listener: null,
    fail: null,
    pricing: null,
    pricingCalls: 0,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        if (channel === 'account:getPricing') {
          fake.pricingCalls += 1
          return fake.pricing as Output<C>
        }
        fake.calls.push({ channel, input })
        if (fake.fail) throw fake.fail
        switch (channel) {
          case 'account:requestLink':
            return PENDING as Output<C>
          case 'account:cancelLink':
          case 'account:signOut':
            return SIGNED_OUT as Output<C>
          case 'account:refresh':
            return SIGNED_IN as Output<C>
          case 'account:getStatus':
            return SIGNED_OUT as Output<C>
          case 'account:getCredits':
            return CREDITS as Output<C>
          case 'account:buyCredits':
            return null as Output<C>
          case 'account:getUsage': {
            const { cursor } = input as Input<'account:getUsage'>
            return USAGE_PAGES[cursor ?? 'first'] as Output<C>
          }
          case 'account:refreshSupporter':
            return LICENSED as Output<C>
          case 'account:buySupporter':
            return null as Output<C>
          case 'account:setAccent':
            return { ...LICENSED, accent: 'sky' } as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        // F-15.5 / F-15.9: the store also listens for the balance and the license; this tab
        // drives only the status one.
        if (event === 'account:balanceChanged' || event === 'account:supporterChanged')
          return () => undefined
        if (event !== 'account:changed') throw new Error(`unexpected ${event}`)
        fake.listener = listener as (status: AccountStatus) => void
        return () => {
          fake.listener = null
        }
      }
    }
  }
  return fake
}

let fake: Fake
const writeText = vi.fn(async () => {})

beforeEach(() => {
  resetAccountStore()
  fake = fakeClient()
  setIpcClient(fake.client)
  useDialogStore.setState({ modals: [], toasts: [] })
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  resetAccountStore()
})

/** The tab reads the store App loaded; the tests put the status there directly. */
const show = (status: AccountStatus | null): void => {
  useAccountStore.setState({ status })
}

/**
 * Signed in with the credits already in the store, so the section renders without a round trip.
 * `creditsAt` is what the store stamps on them; the meter's projection measures from it.
 */
const showWithCredits = (credits: CreditsResult): void => {
  useAccountStore.setState({ status: SIGNED_IN, credits, creditsAt: Date.now() })
}

describe('AccountSettingsTab (F-15.2)', () => {
  it('says an account is optional before it asks for anything', () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    expect(
      screen.getByText(
        'Optional. You never need an account to write. It connects MythScribe Cloud, the paid AI source you can pick per project.'
      )
    ).toBeInTheDocument()
  })

  it('sends the trimmed address and then says the link is on its way', async () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    const send = screen.getByRole('button', { name: 'Send sign-in link' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Email'), '  author@example.com  ')
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(fake.calls).toEqual([
      { channel: 'account:requestLink', input: { email: 'author@example.com' } }
    ])
    expect(
      await screen.findByText(
        'We sent a sign-in link to author@example.com. Open it on any device; this window signs in by itself.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/^The link works until .+\.$/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('submits the form with Enter too', async () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    await userEvent.type(screen.getByLabelText('Email'), 'author@example.com{Enter}')
    await waitFor(() => {
      expect(fake.calls).toEqual([
        { channel: 'account:requestLink', input: { email: 'author@example.com' } }
      ])
    })
  })

  it('sends the link again to the same address while pending', async () => {
    show(PENDING)
    render(<AccountSettingsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Send again' }))
    expect(fake.calls).toEqual([
      { channel: 'account:requestLink', input: { email: 'author@example.com' } }
    ])
  })

  it('cancels a pending link and shows the field again', async () => {
    show(PENDING)
    render(<AccountSettingsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fake.calls).toEqual([{ channel: 'account:cancelLink', input: undefined }])
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })

  it('offers the dev link to copy instead of opening it', async () => {
    show({ ...PENDING, devLink: 'http://127.0.0.1:8787/auth/verify?t=abc' })
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-dev-link')).toHaveTextContent(
      'http://127.0.0.1:8787/auth/verify?t=abc'
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:8787/auth/verify?t=abc')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
  })

  it('names who is signed in, with the day, and signs out', async () => {
    show(SIGNED_IN)
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-signed-in')).toHaveTextContent(
      'Signed in as author@example.com'
    )
    expect(
      screen.getByText(
        `since ${new Date(SIGNED_IN.since ?? '').toLocaleDateString(undefined, { dateStyle: 'medium' })}`
      )
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    // The credits section asked for a balance when it mounted (F-15.3); sign out is the last call.
    expect(fake.calls.at(-1)).toEqual({ channel: 'account:signOut', input: undefined })
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })

  it('asks the Worker once for the day a restored session started', async () => {
    show({ ...SIGNED_IN, since: null })
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls.map((c) => c.channel)).toContain('account:refresh')
    })
    expect(fake.calls.filter((c) => c.channel === 'account:refresh')).toHaveLength(1)
    expect(await screen.findByText(/^since /)).toBeInTheDocument()
  })

  it('shows a failure beside the field instead of a toast', async () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    fake.fail = new IpcRequestError({
      code: 'IO',
      message: 'Sign-in email is not configured. Try again later.'
    })
    await userEvent.type(screen.getByLabelText('Email'), 'author@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in email is not configured. Try again later.'
    )
    expect(useDialogStore.getState().toasts).toHaveLength(0)
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('follows a status main pushes while the tab is open', async () => {
    show(PENDING)
    const off = useAccountStore.getState().subscribe()
    render(<AccountSettingsTab />)
    expect(screen.getByText(/We sent a sign-in link/)).toBeInTheDocument()
    act(() => fake.listener?.(SIGNED_IN))
    expect(await screen.findByTestId('account-signed-in')).toHaveTextContent(
      'Signed in as author@example.com'
    )
    off()
  })
})

describe('AccountSettingsTab balance (F-15.3, AI-BILLING-SPEC E1-E7, C2-C4)', () => {
  it('asks for the balance as soon as the signed-in state is on screen', async () => {
    show(SIGNED_IN)
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls).toEqual([{ channel: 'account:getCredits', input: undefined }])
    })
    expect(await screen.findByTestId('account-balance')).toHaveTextContent('$2.50')
    expect(fake.pricingCalls).toBe(1)
  })

  it('shows the balance, a button per pack, and what each feature has spent, in dollars', async () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(screen.getByRole('heading', { name: 'MythScribe Cloud balance' })).toBeInTheDocument()
    expect(screen.getByTestId('account-balance')).toHaveTextContent('$2.50')

    const spend = screen.getByRole('table', { name: 'Cloud spend by feature' })
    // The table is the period's, not all time: the lifetime chat row is not in it (F-15.5).
    expect(within(spend).getByRole('rowheader', { name: 'Ghost text' })).toBeInTheDocument()
    expect(within(spend).queryByRole('rowheader', { name: 'Chat' })).not.toBeInTheDocument()
    expect(within(spend).getByText('$0.50')).toBeInTheDocument()
    // C4: no token column for hosted users.
    expect(within(spend).queryByText('900')).not.toBeInTheDocument()
    expect(within(spend).queryByText(/tokens/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('account-all-time')).toHaveTextContent('All time: <$0.01')

    // A pack under the $10 minimum is not offered (M4).
    expect(screen.queryByRole('button', { name: 'Add $5.00' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add $10.00' }))
    await waitFor(() => {
      expect(fake.calls.at(-1)).toEqual({
        channel: 'account:buyCredits',
        input: { variantId: 'pack-10' }
      })
    })
    expect(screen.getByRole('button', { name: 'Add $25.00' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add $50.00' })).toBeInTheDocument()
  })

  it('positions Cloud as convenience and says the privacy rule beside the packs (C2, C3)', () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-positioning')).toHaveTextContent(
      "One balance in US dollars for every model, without an API key. Each request costs what the model's provider charges plus 20%"
    )
    expect(screen.getByTestId('account-privacy')).toHaveTextContent(
      'never stores or logs your manuscript, your notes, your questions, or the answers'
    )
    expect(screen.getByTestId('account-terms')).toHaveTextContent(
      'Your balance never expires. Payment is handled by Lemon Squeezy. Unused balance can be refunded within 30 days of buying it.'
    )
    // The word "credits" is gone from the section (it is a balance in dollars).
    const section = screen.getByRole('region', { name: 'Balance' })
    expect(section.textContent).not.toMatch(/credits/i)
  })

  it('lists the models with a multiplier, not a per-token rate (E5, C4)', () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    const models = screen.getByRole('table', { name: 'MythScribe Cloud models' })
    expect(within(models).getByText('DeepSeek V4 Flash')).toBeInTheDocument()
    expect(screen.getByTestId('account-model-price-deepseek/deepseek-v4-flash')).toHaveTextContent(
      'Standard'
    )
    expect(screen.getByTestId('account-model-price-deepseek/deepseek-v4-pro')).toHaveTextContent(
      'about 1.6x the standard price'
    )
    expect(models.textContent).not.toMatch(/per 1M|token/i)
  })

  it('hides the words-left and pack-example lines until the constants are measured (E2, E3)', async () => {
    showWithCredits(CREDITS)
    const unmeasured = render(<AccountSettingsTab />)
    expect(screen.queryByTestId('account-words-left')).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-pack-example-pack-10')).not.toBeInTheDocument()
    unmeasured.unmount()

    fake.pricing = { ...bundledPricing(), wordCosts: { lineEdit: 0.00005, consistencyCheck: null } }
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    // $2.50 / ($0.00005 × 1.2) = 41,666 → 41,000; $10 → 166,666 → 160,000.
    expect(await screen.findByTestId('account-words-left')).toHaveTextContent(
      'About 41,000 words of line editing left'
    )
    expect(screen.getByTestId('account-pack-example-pack-10')).toHaveTextContent(
      'Covers about 160,000 words of line editing.'
    )
  })

  it('says so when no pack is on sale and nothing has been spent', () => {
    showWithCredits({
      balanceMicros: 0,
      spend: [],
      periodDays: USAGE_PERIOD_DAYS,
      periodSpend: [],
      periodFirstChargeAt: null,
      packs: []
    })
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00')
    expect(screen.getByText('Packs are not on sale yet.')).toBeInTheDocument()
    expect(screen.getByText('No Cloud requests yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('account-all-time')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add / })).not.toBeInTheDocument()
  })

  it('shows a balance failure inside the section, with the account still signed in', async () => {
    show(SIGNED_IN)
    fake.fail = new IpcRequestError({
      code: 'IO',
      message: 'Could not reach MythScribe Cloud. Check your connection and try again.'
    })
    render(<AccountSettingsTab />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach MythScribe Cloud. Check your connection and try again.'
    )
    expect(screen.getByTestId('account-signed-in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
    expect(screen.queryByTestId('account-balance')).not.toBeInTheDocument()
    expect(useDialogStore.getState().toasts).toHaveLength(0)
  })

  it('asks again on Refresh', async () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls).toHaveLength(1)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(fake.calls.map((c) => c.channel)).toEqual(['account:getCredits', 'account:getCredits'])
    await waitFor(() => expect(fake.pricingCalls).toBe(2))
  })

  it('meters the rolling period and projects the run-out (F-15.5)', () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(screen.getByText('Used in the last 30 days')).toBeInTheDocument()
    expect(screen.getByTestId('account-period-spent')).toHaveTextContent('$0.50')
    expect(screen.getByTestId('account-run-out')).toHaveTextContent(
      'About 10 days left at this pace'
    )
    expect(screen.queryByTestId('account-balance-warning')).not.toBeInTheDocument()
  })

  it('says it cannot project a period with no spend in it (F-15.5)', () => {
    showWithCredits({ ...CREDITS, periodSpend: [], periodFirstChargeAt: null })
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-period-spent')).toHaveTextContent('$0.00')
    expect(screen.getByTestId('account-run-out')).toHaveTextContent(
      'Not enough usage to project yet'
    )
    expect(screen.getByText('No Cloud requests in the last 30 days.')).toBeInTheDocument()
  })

  it('warns below the configured line, and when the balance is used up (E6)', () => {
    showWithCredits({ ...CREDITS, balanceMicros: 1_420_000 })
    const low = render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-balance-warning')).toHaveTextContent(
      'MythScribe Cloud balance low: $1.42'
    )
    low.unmount()

    showWithCredits({ ...CREDITS, balanceMicros: 0 })
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-balance-warning')).toHaveTextContent(
      'MythScribe Cloud balance used up'
    )
    expect(screen.getByTestId('account-run-out')).toHaveTextContent('Used up')
  })

  it('opens the usage history on demand, with tokens there only, and pages back (E7)', async () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(fake.calls.some((call) => call.channel === 'account:getUsage')).toBe(false)
    await userEvent.click(screen.getByText('Usage history'))
    const history = await screen.findByRole('table', { name: 'Usage history' })
    expect(within(history).getByText('Assistant chat')).toBeInTheDocument()
    expect(within(history).getByText('deepseek/deepseek-v4-flash')).toBeInTheDocument()
    expect(within(history).getByText('1,200 / 300')).toBeInTheDocument()
    expect(within(history).getByText('−<$0.01')).toBeInTheDocument()
    expect(within(history).getByText('Added to balance')).toBeInTheDocument()
    expect(within(history).getByText('+$10.00')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await within(history).findByText('Trial balance')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    expect(
      fake.calls.filter((call) => call.channel === 'account:getUsage').map((call) => call.input)
    ).toEqual([{ cursor: null }, { cursor: 'page-2' }])
  })

  it('shows no balance section while signed out', () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    expect(screen.queryByRole('region', { name: 'Balance' })).not.toBeInTheDocument()
    expect(fake.calls).toEqual([])
  })
})

/**
 * The Supporter section (F-15.9). App loads the license at start, so the tests put the status in
 * the store the way it arrives; the section itself never asks on mount, which is why the signed-out
 * cases make no calls at all.
 */
describe('AccountSettingsTab supporter (F-15.9)', () => {
  const showSupporter = (supporter: SupporterStatus, status: AccountStatus = SIGNED_OUT): void => {
    useAccountStore.setState({ status, supporter, credits: CREDITS, creditsAt: Date.now() })
  }

  it('badges a license with the day it was last confirmed', () => {
    showSupporter(LICENSED, SIGNED_IN)
    render(<AccountSettingsTab />)
    const section = screen.getByRole('region', { name: 'Supporter' })
    expect(within(section).getByTestId('account-supporter-badge')).toHaveTextContent(
      `Supporter since ${new Date(LICENSED.since ?? '').toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    )
    expect(screen.queryByTestId('account-supporter-buy')).not.toBeInTheDocument()
    expect(within(section).queryByText(/Extras stay on until/)).not.toBeInTheDocument()
    // The extras moved to the Appearance tab with the themes (F-7.8).
    expect(screen.queryByTestId('account-accent-sky')).not.toBeInTheDocument()
  })

  it('says how long the extras last while the Worker cannot be reached', () => {
    showSupporter({ ...LICENSED, offline: true }, SIGNED_IN)
    render(<AccountSettingsTab />)
    expect(
      screen.getByText(
        `Extras stay on until ${new Date(LICENSED.validUntil ?? '').toLocaleDateString(undefined, { dateStyle: 'medium' })} while MythScribe Cloud cannot be reached.`
      )
    ).toBeInTheDocument()
  })

  it('offers the one-time purchase at its price to a signed-in account', async () => {
    showSupporter(UNLICENSED, SIGNED_IN)
    render(<AccountSettingsTab />)
    expect(
      screen.getByText(
        'A one-time purchase that supports the project and unlocks the accent colours, the Sepia theme, and custom themes (Settings › Appearance). Nothing else changes: every writing and AI feature works without it.'
      )
    ).toBeInTheDocument()
    const buy = screen.getByTestId('account-supporter-buy')
    expect(buy).toHaveTextContent('Become a Supporter — $39.00')
    expect(buy).toBeEnabled()
    await userEvent.click(buy)
    await waitFor(() => {
      expect(fake.calls.at(-1)).toEqual({ channel: 'account:buySupporter', input: undefined })
    })
    expect(screen.queryByTestId('account-supporter-badge')).not.toBeInTheDocument()
  })

  it('says so when the license is not on sale yet', () => {
    showSupporter({ ...UNLICENSED, product: null }, SIGNED_IN)
    render(<AccountSettingsTab />)
    expect(screen.getByText('The Supporter license is not on sale yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('account-supporter-buy')).not.toBeInTheDocument()
  })

  it('points a signed-out author at the account before the purchase, and asks nothing', () => {
    showSupporter(UNLICENSED)
    render(<AccountSettingsTab />)
    expect(
      screen.getByText(
        'Sign in to buy it: the license belongs to your account, so it follows you to the next machine.'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('account-supporter-buy')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh license' })).toBeDisabled()
    expect(fake.calls).toEqual([])
  })

  it('re-checks the license on Refresh without touching the credits Refresh', async () => {
    showSupporter(UNLICENSED, SIGNED_IN)
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls.map((c) => c.channel)).toEqual(['account:getCredits'])
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh license' }))
    await waitFor(() => {
      expect(screen.getByTestId('account-supporter-badge')).toBeInTheDocument()
    })
    expect(fake.calls.map((c) => c.channel)).toEqual([
      'account:getCredits',
      'account:refreshSupporter'
    ])
  })

  it('keeps a license failure inside its own section', async () => {
    showSupporter(UNLICENSED, SIGNED_IN)
    render(<AccountSettingsTab />)
    fake.fail = new IpcRequestError({
      code: 'IO',
      message: 'Could not reach MythScribe Cloud. Check your connection and try again.'
    })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh license' }))
    const section = screen.getByRole('region', { name: 'Supporter' })
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Could not reach MythScribe Cloud. Check your connection and try again.'
    )
    expect(screen.getByTestId('account-signed-in')).toBeInTheDocument()
    expect(useDialogStore.getState().toasts).toHaveLength(0)
  })

  it('shows the section before anything is loaded', () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    expect(screen.getByRole('region', { name: 'Supporter' })).toBeInTheDocument()
    expect(screen.getByText('The Supporter license is not on sale yet.')).toBeInTheDocument()
  })
})
