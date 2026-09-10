import { describe, expect, it, vi } from 'vitest'
import type { IpcBridge } from '@shared/ipc/contract'
import { createIpcClient, IpcRequestError } from './ipc'

function bridgeWith(invoke: IpcBridge['invoke'], on: IpcBridge['on'] = () => () => {}): IpcBridge {
  return { invoke, on }
}

describe('createIpcClient', () => {
  it('returns validated data on success', async () => {
    const client = createIpcClient(
      bridgeWith(async () => ({ ok: true, data: { version: '0.1.0', platform: 'linux' } }))
    )
    await expect(client.invoke('app:info', undefined)).resolves.toEqual({
      version: '0.1.0',
      platform: 'linux'
    })
  })

  it('throws IpcRequestError with the code on failure', async () => {
    const client = createIpcClient(
      bridgeWith(async () => ({
        ok: false,
        error: { code: 'NO_PROJECT', message: 'nothing open' }
      }))
    )
    await expect(client.invoke('project:close', undefined)).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'NO_PROJECT',
      message: 'nothing open'
    })
  })

  it('rejects malformed output from main', async () => {
    const client = createIpcClient(bridgeWith(async () => ({ ok: true, data: { nope: 1 } })))
    await expect(client.invoke('app:info', undefined)).rejects.toThrow()
  })

  it('validates event payloads and forwards unsubscribe', () => {
    const unsubscribe = vi.fn()
    let handler: ((payload: unknown) => void) | undefined
    const client = createIpcClient(
      bridgeWith(
        async () => ({ ok: true, data: null }),
        (_event, listener) => {
          handler = listener
          return unsubscribe
        }
      )
    )
    const seen: unknown[] = []
    const off = client.on('project:changed', (p) => seen.push(p))
    handler?.(null)
    expect(seen).toEqual([null])
    expect(() => handler?.({ bogus: true })).toThrow()
    off()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(() => new IpcRequestError({ code: 'IO', message: 'x' })).not.toThrow()
  })
})
