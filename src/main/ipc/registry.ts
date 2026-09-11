import { ipcMain } from 'electron'
import {
  contract,
  events,
  type Channel,
  type EventName,
  type EventPayload,
  type Input,
  type IpcResult,
  type Output
} from '@shared/ipc/contract'
import { toIpcError } from './errors'

export type Handler<C extends Channel> = (input: Input<C>) => Promise<Output<C>> | Output<C>

/**
 * Wraps a handler with input validation and error envelope. Pure, so it is unit-testable
 * without Electron; `register` binds it to ipcMain.
 */
export function createHandler<C extends Channel>(
  channel: C,
  fn: Handler<C>
): (raw: unknown) => Promise<IpcResult<Output<C>>> {
  const schema = contract[channel].input
  return async (raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: `Invalid input for ${channel}`,
          details: parsed.error.issues
        }
      }
    }
    try {
      const data = await fn(parsed.data as Input<C>)
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: toIpcError(err) }
    }
  }
}

export function register<C extends Channel>(channel: C, fn: Handler<C>): void {
  const handler = createHandler(channel, fn)
  ipcMain.handle(channel, (_event, raw: unknown) => handler(raw))
}

/** The parts of a BrowserWindow `emit` needs; structural so tests can pass a fake. */
export interface EmitTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export function emit<E extends EventName>(
  windows: EmitTarget[],
  event: E,
  payload: EventPayload<E>
): void {
  events[event].parse(payload)
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}
