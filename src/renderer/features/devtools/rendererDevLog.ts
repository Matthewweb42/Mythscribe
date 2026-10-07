import {
  DEV_LOG_DETAILS_MAX,
  DEV_LOG_MESSAGE_MAX,
  type DevLogLevel,
  type GhostSkipReason
} from '@shared/devtools'
import { ipc } from '@renderer/lib/ipc'
import { useDevToolsStore } from './devToolsStore'

/**
 * The window's side of the developer tools' live log (2026-10-07): uncaught errors, unhandled
 * rejections, and `console.error` / `console.warn` go to main's log while the switch is on, and
 * nowhere while it is off (the store's `enabled` is checked before anything is sent). The console
 * is wrapped, never replaced: the original still prints. A report that fails is dropped in
 * silence, and nothing a report causes is reported again, so a failing channel cannot loop.
 */

let sending = false

/** Sends one entry while developer tools are on; a no-op otherwise. */
export function reportDevLog(level: DevLogLevel, message: string, details: string | null): void {
  if (sending || !useDevToolsStore.getState().enabled) return
  sending = true
  try {
    void ipc()
      .invoke('devtools:log', {
        level,
        message: cut(message, DEV_LOG_MESSAGE_MAX),
        details: details === null ? null : cut(details, DEV_LOG_DETAILS_MAX)
      })
      .catch(() => undefined)
  } finally {
    sending = false
  }
}

/**
 * Ghost text sent nothing on an idle tick: the reason goes to the AI inspector while on.
 * Answers whether it was sent, so the caller's "once per reason" only counts real reports.
 */
export function reportGhostSkip(reason: GhostSkipReason): boolean {
  if (!useDevToolsStore.getState().enabled) return false
  void ipc()
    .invoke('devtools:ghostSkip', { reason })
    .catch(() => undefined)
  return true
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function describe(value: unknown): { message: string; details: string | null } {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, details: value.stack ?? null }
  }
  if (typeof value === 'string') return { message: value, details: null }
  try {
    return { message: JSON.stringify(value) ?? String(value), details: null }
  } catch {
    return { message: String(value), details: null }
  }
}

/**
 * Listens for errors and wraps the console; mounted once by the renderer entry. Returns the
 * removal so a test can take it back off.
 */
export function listenForDevLog(target: Pick<Console, 'error' | 'warn'> = console): () => void {
  const onError = (event: ErrorEvent): void => {
    const { message, details } = describe(event.error ?? event.message)
    reportDevLog('error', message, details)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    const { message, details } = describe(event.reason)
    reportDevLog('error', `Unhandled rejection: ${message}`, details)
  }
  const original = { error: target.error, warn: target.warn }
  const wrap =
    (level: DevLogLevel, fn: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      fn.apply(target, args)
      const parts = args.map(describe)
      const details = parts.find((p) => p.details !== null)?.details ?? null
      reportDevLog(level, parts.map((p) => p.message).join(' '), details)
    }
  target.error = wrap('error', original.error)
  target.warn = wrap('warn', original.warn)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.error = original.error
    target.warn = original.warn
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
