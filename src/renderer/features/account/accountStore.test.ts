import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountStatus } from '@shared/account'
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

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** The `account:changed` listener the store registered, if any. */
  listener: ((status: AccountStatus) => void) | null
  unsubscribed: boolean
  /** Thrown by every channel while set, so the failure path is driven. */
  fail: Error | null
}

function fakeClient(): Fake {
  const fake: Fake = {
    calls: [],
    listener: null,
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
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        if (event !== 'account:changed') throw new Error(`unexpected ${event}`)
        fake.listener = listener as (status: AccountStatus) => void
        return () => {
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

  it('drops an answer from before a reset', async () => {
    const pending = store().load()
    resetAccountStore()
    await pending
    expect(store().status).toBeNull()
    expect(store().busy).toBe(false)
  })
})
