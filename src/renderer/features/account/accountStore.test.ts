import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { CreditsResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAccountStore, useAccountStore } from './accountStore'

const SIGNED_OUT: AccountStatus = { state: 'signedOut' }
const PENDING: AccountStatus = {
  state: 'pending',
  email: 'author@example.com',
  attemptId: 'att-1',
  expiresAt: '2026-09-19T12:15:00.000Z'
}
const SIGNED_IN: AccountStatus = {
  state: 'signedIn',
  email: 'author@example.com',
  userId: 'u-1',
  since: '2026-09-19T12:00:00.000Z'
}

const CREDITS: CreditsResult = {
  balanceMicros: 2_500_000,
  spend: [{ feature: 'ghostText', micros: 1200, requests: 3, tokens: 900 }],
  periodDays: USAGE_PERIOD_DAYS,
  periodSpend: [{ feature: 'ghostText', micros: 400, requests: 1, tokens: 300 }],
  periodFirstChargeAt: 1_758_000_000_000,
  packs: [{ variantId: 'pack-5', priceCents: 500 }]
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** The `account:changed` listener the store registered, if any. */
  listener: ((status: AccountStatus) => void) | null
  /** The `account:balanceChanged` listener (F-15.5), if any. */
  balanceListener: ((payload: { balanceMicros: number }) => void) | null
  /** How many listeners the last `subscribe()` dropped. */
  unsubscribes: number
  unsubscribed: boolean
  /** Thrown by every channel while set, so the failure path is driven. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listener: null,
    balanceListener: null,
    unsubscribes: 0,
    unsubscribed: false,
    fail: null,
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        fake.calls.push({ channel, input })
        if (fake.fail) throw fake.fail
        switch (channel) {
          case 'account:getStatus':
            return SIGNED_OUT as Output<C>
          case 'account:requestLink':
            return PENDING as Output<C>
          case 'account:cancelLink':
            return SIGNED_OUT as Output<C>
          case 'account:signOut':
            return SIGNED_OUT as Output<C>
          case 'account:refresh':
            return SIGNED_IN as Output<C>
          case 'account:getCredits':
            return CREDITS as Output<C>
          case 'account:buyCredits':
            return null as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        if (event === 'account:balanceChanged') {
          fake.balanceListener = listener as (payload: { balanceMicros: number }) => void
          return () => {
            fake.unsubscribes++
            fake.balanceListener = null
          }
        }
        if (event !== 'account:changed') throw new Error(`unexpected ${event}`)
        fake.listener = listener as (status: AccountStatus) => void
        return () => {
          fake.unsubscribes++
          fake.unsubscribed = true
          fake.listener = null
        }
      }
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useAccountStore.getState> => useAccountStore.getState()

beforeEach(() => {
  resetAccountStore()
  fake = fakeClient()
  setIpcClient(fake.client)
})

describe('accountStore (F-15.2)', () => {
  it('starts empty and loads the status main answers', async () => {
    expect(store().status).toBeNull()
    expect(store().busy).toBe(false)
    await store().load()
    expect(fake.calls).toEqual([{ channel: 'account:getStatus', input: undefined }])
    expect(store().status).toEqual(SIGNED_OUT)
    expect(store().busy).toBe(false)
    expect(store().error).toBeNull()
  })

  it('sends the trimmed address and keeps the pending status', async () => {
    await store().requestLink('  Author@example.com  ')
    expect(fake.calls).toEqual([
      { channel: 'account:requestLink', input: { email: 'Author@example.com' } }
    ])
    expect(store().status).toEqual(PENDING)
  })

  it('cancels, signs out, and refreshes through their own channels', async () => {
    await store().requestLink('author@example.com')
    await store().cancelLink()
    expect(store().status).toEqual(SIGNED_OUT)
    await store().signOut()
    expect(store().status).toEqual(SIGNED_OUT)
    await store().refresh()
    expect(store().status).toEqual(SIGNED_IN)
    expect(fake.calls.map((c) => c.channel)).toEqual([
      'account:requestLink',
      'account:cancelLink',
      'account:signOut',
      'account:refresh'
    ])
  })

  it('keeps a failure as the error, leaves the status alone, and clears busy', async () => {
    await store().load()
    fake.fail = new IpcRequestError({
      code: 'IO',
      message: 'No connection to MythScribe Cloud. Check your network and try again.'
    })
    await store().requestLink('author@example.com')
    expect(store().error).toBe(
      'No connection to MythScribe Cloud. Check your network and try again.'
    )
    expect(store().status).toEqual(SIGNED_OUT)
    expect(store().busy).toBe(false)
    // The next action starts from a clean slate.
    fake.fail = null
    await store().load()
    expect(store().error).toBeNull()
  })

  it('takes the status main pushes and stops on unsubscribe', async () => {
    const off = store().subscribe()
    await store().load()
    expect(fake.listener).not.toBeNull()
    fake.listener?.(SIGNED_IN)
    expect(store().status).toEqual(SIGNED_IN)
    off()
    expect(fake.unsubscribed).toBe(true)
  })

  it('drops a pushed error left over from a state that is gone', async () => {
    store().subscribe()
    fake.fail = new IpcRequestError({ code: 'IO', message: 'rate limited' })
    await store().requestLink('author@example.com')
    expect(store().error).toBe('rate limited')
    fake.listener?.(SIGNED_IN)
    expect(store().error).toBeNull()
    expect(store().status).toEqual(SIGNED_IN)
  })

  it('loads the credits of the signed-in account', async () => {
    await store().loadCredits()
    expect(fake.calls).toEqual([{ channel: 'account:getCredits', input: undefined }])
    expect(store().credits).toEqual(CREDITS)
    expect(store().creditsBusy).toBe(false)
    expect(store().creditsError).toBeNull()
  })

  it('opens a checkout without touching the balance it already has', async () => {
    await store().loadCredits()
    await store().buyCredits('pack-5')
    expect(fake.calls[1]).toEqual({
      channel: 'account:buyCredits',
      input: { variantId: 'pack-5' }
    })
    expect(store().credits).toEqual(CREDITS)
  })

  it('keeps a credits failure out of the sign-in error', async () => {
    await store().load()
    fake.fail = new IpcRequestError({ code: 'IO', message: 'Could not reach MythScribe Cloud.' })
    await store().loadCredits()
    expect(store().creditsError).toBe('Could not reach MythScribe Cloud.')
    expect(store().error).toBeNull()
    expect(store().status).toEqual(SIGNED_OUT)
    expect(store().creditsBusy).toBe(false)
  })

  it('drops the credits with the account on sign out', async () => {
    await store().loadCredits()
    await store().signOut()
    expect(store().credits).toBeNull()
    expect(store().creditsError).toBeNull()
  })

  it('drops the credits when main pushes a state that is not signed in', async () => {
    store().subscribe()
    await store().loadCredits()
    fake.listener?.(SIGNED_IN)
    expect(store().credits).toEqual(CREDITS)
    fake.listener?.(SIGNED_OUT)
    expect(store().credits).toBeNull()
  })

  it('drops a credits answer from before a reset', async () => {
    const pending = store().loadCredits()
    resetAccountStore()
    await pending
    expect(store().credits).toBeNull()
    expect(store().creditsBusy).toBe(false)
  })

  it('follows the balance main pushes with an answered Cloud request (F-15.5)', async () => {
    store().subscribe()
    await store().loadCredits()
    fake.balanceListener?.({ balanceMicros: 2_487_000 })
    expect(store().credits).toEqual({ ...CREDITS, balanceMicros: 2_487_000 })
    // Only the balance is live: the period and its breakdown stay as they were loaded.
    expect(fake.calls.map((c) => c.channel)).toEqual(['account:getCredits'])
  })

  it('asks for the credits once when a charge arrives before they were loaded (F-15.5)', async () => {
    store().subscribe()
    useAccountStore.setState({ status: SIGNED_IN })
    fake.balanceListener?.({ balanceMicros: 900_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.calls.map((c) => c.channel)).toEqual(['account:getCredits'])
    expect(store().credits).toEqual(CREDITS)
  })

  it('ignores a pushed balance while signed out (F-15.5)', () => {
    store().subscribe()
    useAccountStore.setState({ status: SIGNED_OUT })
    fake.balanceListener?.({ balanceMicros: 900_000 })
    expect(fake.calls).toEqual([])
    expect(store().credits).toBeNull()
  })

  it('drops both listeners on unsubscribe (F-15.5)', () => {
    const off = store().subscribe()
    expect(fake.balanceListener).not.toBeNull()
    off()
    expect(fake.unsubscribes).toBe(2)
    expect(fake.balanceListener).toBeNull()
    expect(fake.listener).toBeNull()
  })

  it('drops an answer from before a reset', async () => {
    const pending = store().load()
    resetAccountStore()
    await pending
    expect(store().status).toBeNull()
    expect(store().busy).toBe(false)
  })
})
