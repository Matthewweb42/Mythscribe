import {
  contract,
  events,
  type Channel,
  type EventName,
  type EventPayload,
  type Input,
  type IpcBridge,
  type IpcError,
  type Output
} from '@shared/ipc/contract'

export class IpcRequestError extends Error {
  readonly code: IpcError['code']
  readonly details: unknown
  constructor(error: IpcError) {
    super(error.message)
    this.name = 'IpcRequestError'
    this.code = error.code
    this.details = error.details
  }
}

export interface IpcClient {
  invoke: <C extends Channel>(channel: C, input: Input<C>) => Promise<Output<C>>
  on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => () => void
}

/** Typed client over the preload bridge. Outputs and event payloads are validated on arrival. */
export function createIpcClient(bridge: IpcBridge): IpcClient {
  return {
    async invoke(channel, input) {
      const result = await bridge.invoke(channel, input)
      if (!result.ok) throw new IpcRequestError(result.error)
      return contract[channel].output.parse(result.data) as Output<typeof channel>
    },
    on(event, listener) {
      return bridge.on(event, (payload) => {
        listener(events[event].parse(payload))
      })
    }
  }
}

let client: IpcClient | null = null

/** The app-wide client. Tests replace it with `setIpcClient`. */
export function ipc(): IpcClient {
  if (!client) {
    if (typeof window === 'undefined' || !window.mythscribe) {
      throw new Error('IPC bridge is not available; is the preload script loaded?')
    }
    client = createIpcClient(window.mythscribe)
  }
  return client
}

export function setIpcClient(next: IpcClient | null): void {
  client = next
}
