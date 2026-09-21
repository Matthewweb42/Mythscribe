import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
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
  packs: [{ variantId: 'pack-5', priceCents: 500 }]
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  listener: ((status: AccountStatus) => void) | null
  /** Thrown by every channel while set. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listener: null,
    fail: null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
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
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        // F-15.5: the store also listens for the balance; this tab drives only the status one.
        if (event === 'account:balanceChanged') return () => undefined
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
        'Optional. You never need an account to write. It will connect MythScribe Cloud, which is not available yet.'
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

describe('AccountSettingsTab credits (F-15.3)', () => {
  it('asks for the credits as soon as the signed-in state is on screen', async () => {
    show(SIGNED_IN)
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls).toEqual([{ channel: 'account:getCredits', input: undefined }])
    })
    expect(await screen.findByTestId('account-credit-balance')).toHaveTextContent('$2.50')
  })

  it('shows the balance, a button per pack, and what each feature has spent', async () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$2.50')

    const spend = screen.getByRole('table', { name: 'Cloud spend by feature' })
    // The table is the period's, not all time: the lifetime chat row is not in it (F-15.5).
    expect(within(spend).getByRole('rowheader', { name: 'Ghost text' })).toBeInTheDocument()
    expect(within(spend).queryByRole('rowheader', { name: 'Chat' })).not.toBeInTheDocument()
    expect(within(spend).getByText('900')).toBeInTheDocument()
    expect(within(spend).getByText('$0.50')).toBeInTheDocument()
    expect(screen.getByTestId('account-all-time')).toHaveTextContent('All time: <$0.01')

    await userEvent.click(screen.getByRole('button', { name: 'Buy $5.00' }))
    await waitFor(() => {
      expect(fake.calls.at(-1)).toEqual({
        channel: 'account:buyCredits',
        input: { variantId: 'pack-5' }
      })
    })
  })

  it('publishes the Cloud rate per model with the margin said out loud', () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    const rates = screen.getByRole('table', { name: 'MythScribe Cloud rates' })
    const row = within(rates).getByRole('rowheader', { name: 'gpt-5.4-mini' }).closest('tr')
    expect(row).not.toBeNull()
    // 0.25 and 2.00 per 1M at the provider, doubled by CLOUD_RATE_MULTIPLIER.
    expect(within(row as HTMLElement).getByText('$0.50')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText('$4.00')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText('fast')).toBeInTheDocument()
    expect(
      screen.getByText(
        "Rates include MythScribe's margin over the provider price; each request is charged at the rate of the model that answered."
      )
    ).toBeInTheDocument()
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
    expect(screen.getByTestId('account-credit-balance')).toHaveTextContent('$0.00')
    expect(screen.getByText('Credit packs are not on sale yet.')).toBeInTheDocument()
    expect(screen.getByText('No Cloud requests yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('account-all-time')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Buy / })).not.toBeInTheDocument()
  })

  it('shows a credits failure inside the section, with the account still signed in', async () => {
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
    expect(screen.queryByTestId('account-credit-balance')).not.toBeInTheDocument()
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
  })

  it('meters the rolling period and projects the run-out (F-15.5)', () => {
    showWithCredits(CREDITS)
    render(<AccountSettingsTab />)
    expect(screen.getByText('Used in the last 30 days')).toBeInTheDocument()
    expect(screen.getByTestId('account-period-spent')).toHaveTextContent('$0.50')
    expect(screen.getByTestId('account-run-out')).toHaveTextContent(
      'About 10 days left at this pace'
    )
    expect(screen.queryByTestId('account-credit-warning')).not.toBeInTheDocument()
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

  it('warns beside the meter when the balance is low or used up (F-15.5)', () => {
    showWithCredits({ ...CREDITS, balanceMicros: 420_000 })
    const low = render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-credit-warning')).toHaveTextContent(
      'Cloud credits low: $0.42'
    )
    low.unmount()

    showWithCredits({ ...CREDITS, balanceMicros: 0 })
    render(<AccountSettingsTab />)
    expect(screen.getByTestId('account-credit-warning')).toHaveTextContent('Cloud credits used up')
    expect(screen.getByTestId('account-run-out')).toHaveTextContent('Used up')
  })

  it('shows no credits section while signed out', () => {
    show(SIGNED_OUT)
    render(<AccountSettingsTab />)
    expect(screen.queryByRole('region', { name: 'Credits' })).not.toBeInTheDocument()
    expect(fake.calls).toEqual([])
  })
})
