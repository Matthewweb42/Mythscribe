import {
  CRASH_NAME_MAX,
  DIAGNOSTICS_FLUSH_DELAY_MS,
  DIAGNOSTICS_FLUSH_INTERVAL_MS,
  DIAGNOSTICS_PENDING_MAX,
  DIAGNOSTIC_COUNTERS,
  DIAGNOSTIC_COUNT_MAX,
  DIAGNOSTIC_DAYS_MAX,
  DIAGNOSTIC_QUEUE_MAX,
  DIAGNOSTIC_ROWS_MAX,
  scrubMessage,
  scrubStack,
  type CrashKind,
  type CrashReport,
  type DiagnosticCountRow,
  type DiagnosticCounter,
  type DiagnosticCounts,
  type DiagnosticsEnvironment,
  type DiagnosticsSettings,
  type DiagnosticsState
} from '@shared/diagnostics'
import type { DiagnosticsBody } from '@shared/cloudApi'
import type { AppStateStore } from '../appState/appStateStore'
import { dayOf } from '../ai/dailyCap'
import { defaultSchedule, type Schedule } from '../schedule'

/**
 * The one owner of diagnostics (F-15.8). It is off on every install and records nothing while it
 * is off: no counter, no crash, nothing on disk to send. Turned on, it keeps a per-day tally of
 * a fixed set of counters and a short queue of scrubbed crash reports in app-state.json, and
 * hands completed days to the sender it was built with. Turning it off clears both.
 *
 * Built like `UpdateService`: the timer and the network are injected, so its tests run the
 * callbacks themselves and nothing leaves a test machine. With no sender (the default, and what
 * a test or a build without a diagnostics endpoint gets) it still records and still shows the
 * author what would be sent; a flush simply has nowhere to go.
 */

/** Posts one report; resolves when the endpoint accepted it, rejects on anything else. */
export type DiagnosticsSend = (body: DiagnosticsBody) => Promise<void>

/** What an error looks like once it has crossed IPC or come out of a process-gone event. */
export interface ErrorLike {
  name?: string
  message?: string
  stack?: string | string[] | null
}

export interface DiagnosticsServiceOptions {
  appState: AppStateStore
  /** Version, platform, arch, Electron: everything a report says about where it came from. */
  environment: DiagnosticsEnvironment
  onChange: (state: DiagnosticsState) => void
  /** Where a flush goes; null (the default) records but never sends. */
  send?: DiagnosticsSend | null
  /** Absolute roots of the app bundle; only stack frames inside them survive scrubbing. */
  appRoots?: readonly string[]
  now?: () => number
  schedule?: Schedule
}

export class DiagnosticsService {
  private readonly appState: AppStateStore
  private readonly environment: DiagnosticsEnvironment
  private readonly onChange: (state: DiagnosticsState) => void
  private readonly send: DiagnosticsSend | null
  private readonly appRoots: readonly string[]
  private readonly now: () => number
  private readonly schedule: Schedule

  private cancelTimer: (() => void) | null = null
  private started = false
  private disposed = false

  constructor(options: DiagnosticsServiceOptions) {
    this.appState = options.appState
    this.environment = options.environment
    this.onChange = options.onChange
    this.send = options.send ?? null
    this.appRoots = options.appRoots ?? []
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? defaultSchedule
  }

  /** What the Diagnostics tab reads: the switch, the next report verbatim, the last send. */
  state(): DiagnosticsState {
    const settings = this.settings()
    const pending = JSON.stringify(this.pendingBody(settings), null, 2)
    return {
      enabled: settings.enabled,
      pending: pending.slice(0, DIAGNOSTICS_PENDING_MAX),
      lastSentDay: settings.lastSentDay
    }
  }

  /**
   * Turns diagnostics on or off. Either way the tally and the queue start empty: turning it off
   * throws away what was recorded, and turning it on never sends something from before consent.
   */
  setEnabled(on: boolean): DiagnosticsState {
    const settings = this.settings()
    if (settings.enabled === on) return this.state()
    this.write(() => ({ ...settings, enabled: on, counts: {}, queue: [] }))
    this.emit()
    return this.state()
  }

  /**
   * Adds one to a counter for today. A no-op while diagnostics are off. No event follows: the
   * counters move often (every AI request is one) and the tab reads the state when it opens.
   */
  count(counter: DiagnosticCounter): void {
    if (!this.settings().enabled) return
    const day = dayOf(new Date(this.now()))
    this.write((settings) => {
      const counts = pruneDays(settings.counts, day)
      const tally = counts[day] ?? {}
      return {
        ...settings,
        counts: { ...counts, [day]: { ...tally, [counter]: (tally[counter] ?? 0) + 1 } }
      }
    })
  }

  /**
   * Queues a crash, scrubbed: the error's class, a message with every quoted string, path, URL
   * and address taken out, and only the stack frames inside the app bundle. A no-op while
   * diagnostics are off, and once the queue is full the newer crashes are dropped rather than
   * pushing out the first one, which is usually the cause.
   */
  reportError(kind: CrashKind, error: unknown): void {
    if (!this.settings().enabled) return
    const report = this.crashReport(kind, error)
    this.write((settings) =>
      settings.queue.length >= DIAGNOSTIC_QUEUE_MAX
        ? settings
        : { ...settings, queue: [...settings.queue, report] }
    )
  }

  /**
   * Sends the completed days and the queued crashes, if there is a sender and anything to send.
   * What the endpoint accepted is dropped; a failure keeps everything and says nothing — a
   * diagnostics report is never worth a dialog, and the caps bound how much can pile up.
   */
  async flush(): Promise<void> {
    const send = this.send
    if (send === null) return
    const settings = this.settings()
    if (!settings.enabled) return
    const body = this.pendingBody(settings)
    if (body.counts.length === 0 && body.crashes.length === 0) return
    try {
      await send(body)
    } catch {
      return
    }
    const sentDays = new Set(body.counts.map((row) => row.day))
    const sentCrashes = body.crashes.length
    const lastSentDay = body.counts[body.counts.length - 1]?.day ?? settings.lastSentDay
    // Read again: a count or a crash may have arrived while the request was in flight.
    this.write((current) => ({
      ...current,
      counts: withoutDays(current.counts, sentDays),
      queue: current.queue.slice(sentCrashes),
      lastSentDay
    }))
    this.emit()
  }

  /** Begins the cycle: one flush shortly after start, then one every few hours. */
  start(): void {
    this.started = true
    this.arm(DIAGNOSTICS_FLUSH_DELAY_MS)
  }

  /** The app is quitting: drop the timer. Nothing stored changes. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  /** The report the next flush would send: completed days only, plus the queued crashes. */
  private pendingBody(settings: DiagnosticsSettings): DiagnosticsBody {
    return {
      ...this.environment,
      counts: settings.enabled ? completedRows(settings.counts, dayOf(new Date(this.now()))) : [],
      crashes: settings.enabled ? settings.queue : []
    }
  }

  private crashReport(kind: CrashKind, error: unknown): CrashReport {
    const like = asErrorLike(error)
    return {
      ...this.environment,
      kind,
      name: scrubMessage(like.name ?? 'Error').slice(0, CRASH_NAME_MAX),
      message: scrubMessage(like.message ?? ''),
      stack: scrubStack(like.stack, this.appRoots)
    }
  }

  private settings(): DiagnosticsSettings {
    return this.appState.get().diagnostics
  }

  private write(fn: (settings: DiagnosticsSettings) => DiagnosticsSettings): void {
    this.appState.update((state) => ({ ...state, diagnostics: fn(state.diagnostics) }))
  }

  private emit(): void {
    if (this.disposed) return
    this.onChange(this.state())
  }

  private arm(ms: number): void {
    if (this.disposed || !this.started) return
    this.stopTimer()
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.flush().then(() => this.arm(DIAGNOSTICS_FLUSH_INTERVAL_MS))
    }, ms)
  }

  private stopTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }
}

/** An Error, something Error-shaped that crossed IPC, or anything else read as its text. */
function asErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null) {
    const name = 'name' in error && typeof error.name === 'string' ? error.name : undefined
    const message =
      'message' in error && typeof error.message === 'string' ? error.message : undefined
    if (name !== undefined || message !== undefined) {
      return { name, message, stack: 'stack' in error ? stackOf(error.stack) : null }
    }
  }
  return { name: 'Error', message: String(error) }
}

/** A stack as the platform or the renderer handed it over: one string, or already split. */
function stackOf(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((frame) => typeof frame === 'string')) return value
  return null
}

/** Today plus the days before it that are still worth sending; anything older is dropped. */
function pruneDays(counts: DiagnosticCounts, today: string): DiagnosticCounts {
  const days = Object.keys(counts)
  if (days.length < DIAGNOSTIC_DAYS_MAX) return counts
  const keep = new Set([today, ...days.sort().slice(-(DIAGNOSTIC_DAYS_MAX - 1))])
  return withoutDays(counts, new Set(days.filter((day) => !keep.has(day))))
}

function withoutDays(counts: DiagnosticCounts, drop: ReadonlySet<string>): DiagnosticCounts {
  if (drop.size === 0) return counts
  return Object.fromEntries(Object.entries(counts).filter(([day]) => !drop.has(day)))
}

/**
 * The rows of every day before `today`, oldest first: a day is sent once it can no longer
 * change, so a counter is never reported twice for the same day. Capped, with each count
 * clamped, so one report stays small however long the app was offline.
 */
function completedRows(counts: DiagnosticCounts, today: string): DiagnosticCountRow[] {
  const rows: DiagnosticCountRow[] = []
  for (const day of Object.keys(counts).sort()) {
    if (day >= today) continue
    const tally = counts[day]
    if (tally === undefined) continue
    // Over the enum rather than the stored keys: the counters come out in one fixed order, and
    // a key a hand-edited file invented is left behind instead of reaching the wire.
    for (const counter of DIAGNOSTIC_COUNTERS) {
      const n = tally[counter]
      if (n === undefined || n <= 0) continue
      if (rows.length === DIAGNOSTIC_ROWS_MAX) return rows
      rows.push({ day, counter, n: Math.min(n, DIAGNOSTIC_COUNT_MAX) })
    }
  }
  return rows
}
