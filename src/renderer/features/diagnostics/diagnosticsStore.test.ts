import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiagnosticsState } from '@shared/diagnostics'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDiagnosticsStore, useDiagnosticsStore } from './diagnosticsStore'

const EMPTY_BODY = JSON.stringify(
  {
    appVersion: '0.1.0',
    platform: 'linux',
    arch: 'arm64',
    electron: '38',
    counts: [],
    crashes: []
  },
  null,
  2
)

const OFF: DiagnosticsState = { enabled: false, pending: EMPTY_BODY, lastSentDay: null }
const ON: DiagnosticsState = { ...OFF, enabled: true }

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** The `diagnostics:changed` listener the store registered, if any. */
  listener: ((state: DiagnosticsState) => void) | null
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
          case 'diagnostics:getState':
            return OFF as Output<C>
          case 'diagnostics:setEnabled':
            return {
              ...OFF,
              enabled: (input as { on: boolean }).on
            } as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
        if (event !== 'diagnostics:changed') throw new Error(`unexpected ${event}`)
        fake.listener = listener as (state: DiagnosticsState) => void
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
const store = (): ReturnType<typeof useDiagnosticsStore.getState> => useDiagnosticsStore.getState()
const channels = (): Channel[] => fake.calls.map((call) => call.channel)

beforeEach(() => {
  resetDiagnosticsStore()
  fake = fakeClient()
  setIpcClient(fake.client)
})
afterEach(() => {
  resetDiagnosticsStore()
})

describe('diagnosticsStore (F-15.8)', () => {
  it('starts empty and loads the state main answers, which is off', async () => {
    expect(store().state).toBeNull()
    await store().load()
    expect(store().state).toEqual(OFF)
    expect(store().busy).toBe(false)
    expect(channels()).toEqual(['diagnostics:getState'])
  })

  it('turns diagnostics on and off through main', async () => {
    await store().setEnabled(true)
    expect(store().state?.enabled).toBe(true)
    await store().setEnabled(false)
    expect(store().state?.enabled).toBe(false)
    expect(fake.calls).toEqual([
      { channel: 'diagnostics:setEnabled', input: { on: true } },
      { channel: 'diagnostics:setEnabled', input: { on: false } }
    ])
  })

  it('keeps a failure beside the switch and clears it on the next action', async () => {
    fake.fail = new IpcRequestError({ code: 'IO', message: 'Could not write the setting.' })
    await store().setEnabled(true)
    expect(store().error).toBe('Could not write the setting.')
    expect(store().state).toBeNull()
    expect(store().busy).toBe(false)
    fake.fail = null
    await store().setEnabled(true)
    expect(store().error).toBeNull()
    expect(store().state?.enabled).toBe(true)
  })

  it('subscribes once, loads, and takes the state main pushes after a report is sent', () => {
    const off = store().subscribe()
    expect(channels()).toEqual(['diagnostics:getState'])
    const sent: DiagnosticsState = { ...ON, lastSentDay: '2026-09-20' }
    fake.listener?.(sent)
    expect(store().state).toEqual(sent)
    expect(store().error).toBeNull()
    off()
    expect(fake.unsubscribed).toBe(true)
  })

  it('drops the answer to a request a reset invalidated', async () => {
    const pending = store().load()
    resetDiagnosticsStore()
    await pending
    expect(store().state).toBeNull()
    expect(store().busy).toBe(false)
  })
})
