import {
  DIAGNOSTIC_QUEUE_MAX,
  RENDERER_ERROR_MESSAGE_MAX,
  RENDERER_ERROR_NAME_MAX,
  RENDERER_ERROR_STACK_MAX
} from '@shared/diagnostics'
import { ipc } from '@renderer/lib/ipc'

/**
 * Renderer crashes for the diagnostics service (F-15.8). An uncaught error or an unhandled
 * rejection in the window is handed to main, which scrubs the message and the stack and queues
 * it only while diagnostics are on — the renderer never decides whether it is recorded, so this
 * listener is the same with the switch off. It changes nothing else: the error still reaches the
 * console, and nothing here shows the author a dialog.
 */

/** What the channel takes; main throws the raw text away and stores the scrubbed version. */
export interface RendererErrorFields {
  name: string
  message: string
  stack: string | null
}

/**
 * Whatever was thrown, as the three fields of the channel, cut to the lengths it accepts (an
 * over-long field would be refused as a validation error and the crash would be lost). `fallback`
 * names the kind of failure when what was thrown is not an `Error`.
 */
export function rendererErrorFields(value: unknown, fallback: string): RendererErrorFields {
  if (value instanceof Error) {
    return {
      name: cut(value.name === '' ? fallback : value.name, RENDERER_ERROR_NAME_MAX),
      message: cut(value.message, RENDERER_ERROR_MESSAGE_MAX),
      stack: typeof value.stack === 'string' ? cut(value.stack, RENDERER_ERROR_STACK_MAX) : null
    }
  }
  return { name: fallback, message: cut(String(value), RENDERER_ERROR_MESSAGE_MAX), stack: null }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * Listens for uncaught errors and unhandled rejections in this window and reports them. Mounted
 * once by the renderer entry; returns the removal so a test can take it back off.
 *
 * At most `DIAGNOSTIC_QUEUE_MAX` reports leave one window session — main keeps no more than that
 * anyway — so an error that fires in a render loop cannot flood the IPC channel. A report that
 * fails is dropped in silence: reporting the failure of a report is how a loop starts.
 */
export function listenForRendererErrors(): () => void {
  let sent = 0

  const report = (value: unknown, fallback: string): void => {
    if (sent >= DIAGNOSTIC_QUEUE_MAX) return
    sent += 1
    void ipc()
      .invoke('diagnostics:reportRendererError', rendererErrorFields(value, fallback))
      .catch(() => undefined)
  }

  const onError = (event: ErrorEvent): void => {
    report(event.error ?? event.message, 'Error')
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    report(event.reason, 'UnhandledRejection')
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
