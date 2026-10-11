import { ipcMain } from 'electron'
import {
  contract,
  events,
  type Channel,
  type EventName,
  type EventPayload,
  type IpcError,
  type IpcResult,
  type ParsedInput,
  type Output
} from '@shared/ipc/contract'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { assertChannelMemory } from './channelAccess'
import { IPC_LOG_PREFIX, toIpcError } from './errors'

export type Handler<C extends Channel> = (input: ParsedInput<C>) => Promise<Output<C>> | Output<C>

/**
 * Told about every error envelope a channel answers (developer tools' live log), with what was
 * thrown when there was something; must not throw.
 */
export type FailureObserver = (channel: Channel, error: IpcError, cause?: unknown) => void

/**
 * The story memory the open project runs, or null when none is open (F-16.4): what the registry
 * checks a channel's `CHANNEL_MEMORY` against before its handler runs.
 */
export type MemoryOf = () => StoryMemoryVersion | null

/**
 * Wraps a handler with input validation, the story-memory gate (F-16.4: a `v2` channel in a v1
 * project, or a `v1` channel in a v2 project, is refused with VALIDATION before the handler
 * runs, when `memoryOf` is given) and error envelope. Pure, so it is unit-testable without
 * Electron; `register` binds it to ipcMain.
 */
export function createHandler<C extends Channel>(
  channel: C,
  fn: Handler<C>,
  onFailure?: FailureObserver,
  memoryOf?: MemoryOf
): (raw: unknown) => Promise<IpcResult<Output<C>>> {
  const schema = contract[channel].input
  return async (raw) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const error: IpcError = {
        code: 'VALIDATION',
        message: `Invalid input for ${channel}`,
        details: parsed.error.issues
      }
      onFailure?.(channel, error)
      return { ok: false, error }
    }
    try {
      if (memoryOf !== undefined) assertChannelMemory(channel, memoryOf())
      const data = await fn(parsed.data as ParsedInput<C>)
      return { ok: true, data }
    } catch (err) {
      const error = toIpcError(err)
      // Expected AppErrors are the renderer's to show; anything else is a bug worth a stack trace.
      if (error.code === 'INTERNAL') console.error(`${IPC_LOG_PREFIX} ${channel} failed`, err)
      onFailure?.(channel, error, err)
      return { ok: false, error }
    }
  }
}

export function register<C extends Channel>(
  channel: C,
  fn: Handler<C>,
  onFailure?: FailureObserver,
  memoryOf?: MemoryOf
): void {
  const handler = createHandler(channel, fn, onFailure, memoryOf)
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
