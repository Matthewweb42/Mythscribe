import type { CrashKind } from '@shared/diagnostics'
import type { ErrorLike } from './diagnosticsService'

/**
 * What the main process does when it, or a process it owns, falls over (F-15.8). Two jobs, in
 * this order: hand the failure to the diagnostics service — which scrubs it and, while
 * diagnostics are off, drops it — and then show the author exactly what Electron would have
 * shown. Electron's default error box only appears while nothing else listens for
 * `uncaughtException`, so listening here without raising it would turn a crash into silence.
 *
 * Injected rather than reaching for `process` and `dialog`, so this is tested without Electron;
 * `index.ts` binds it once to the real ones.
 */

/** Electron's own title for a main-process failure; kept so nothing about the box changes. */
export const CRASH_DIALOG_TITLE = 'A JavaScript error occurred in the main process'

/** The part of `process` this needs; structural, so a test passes a plain object. */
export interface CrashProcessLike {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

export interface CrashHandlerOptions {
  process: CrashProcessLike
  /** `DiagnosticsService.reportError`; a no-op while diagnostics are off. */
  report: (kind: CrashKind, error: unknown) => void
  /** `dialog.showErrorBox`. */
  showErrorBox: (title: string, content: string) => void
}

export function installCrashHandlers({
  process: target,
  report,
  showErrorBox
}: CrashHandlerOptions): void {
  // Reporting writes app-state.json, which can fail (disk full, permissions) at exactly the
  // moment something else has gone wrong. A throw from inside these listeners would end the
  // process before the box is raised, so a failed report is dropped: the box matters more.
  const reportQuietly = (error: unknown): void => {
    try {
      report('main', error)
    } catch {
      // Nothing to do with it here: the original failure is the one the author is shown.
    }
  }
  target.on('uncaughtException', (error) => {
    reportQuietly(error)
    showErrorBox(CRASH_DIALOG_TITLE, `Uncaught Exception:\n${detailOf(error)}`)
  })
  // Without a listener Node turns an unhandled rejection into an uncaught exception, which ends
  // in the same box; with one, the box is raised here so the outcome the author sees is the same.
  target.on('unhandledRejection', (reason) => {
    reportQuietly(reason)
    showErrorBox(CRASH_DIALOG_TITLE, `Unhandled Promise Rejection:\n${detailOf(reason)}`)
  })
}

/** What the box shows: the stack when there is one, as Electron's default handler does. */
function detailOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

/**
 * What Electron's `render-process-gone` and `child-process-gone` events say. Structural subsets
 * of `RenderProcessGoneDetails` and the child-process one, so both pass without a cast.
 */
export interface ProcessGoneDetails {
  reason: string
  exitCode: number
  /** `child-process-gone` only: which kind of helper process it was. */
  type?: string
}

/**
 * A dead process as a crash report's error. Only the event's own vocabulary reaches it — a
 * reason and a process type from Electron's fixed sets, and an exit code — because a dead
 * process has no JavaScript stack and its memory (which could hold manuscript text) is never
 * looked at.
 */
export function processGoneError(
  source: 'renderer' | 'child',
  details: ProcessGoneDetails
): ErrorLike {
  const type = details.type === undefined ? '' : ` type=${details.type}`
  return {
    name: source === 'renderer' ? 'RenderProcessGone' : 'ChildProcessGone',
    message: `reason=${details.reason} exitCode=${details.exitCode}${type}`,
    stack: null
  }
}
