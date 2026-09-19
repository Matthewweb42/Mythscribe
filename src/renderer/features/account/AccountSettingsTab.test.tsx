import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '@shared/account'
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
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
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
    expect(fake.calls).toEqual([{ channel: 'account:signOut', input: undefined }])
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })

  it('asks the Worker once for the day a restored session started', async () => {
    show({ ...SIGNED_IN, since: null })
    render(<AccountSettingsTab />)
    await waitFor(() => {
      expect(fake.calls).toEqual([{ channel: 'account:refresh', input: undefined }])
    })
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
