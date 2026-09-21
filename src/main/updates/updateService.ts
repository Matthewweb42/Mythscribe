import {
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_ERROR_NEXT_STEP,
  releaseNotesText,
  updaterChannelFor,
  type ReleaseNoteEntry,
  type ReleaseNotes,
  type UpdateChannel,
  type UpdateSettings,
  type UpdateState,
  type UpdateStatus
} from '@shared/updates'
import type { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import { defaultSchedule, type Schedule } from '../schedule'

/**
 * The one owner of the update state (F-15.7). It drives `electron-updater` — which is injected,
 * so the service is tested without it and is simply `null` wherever updates cannot work (a
 * development build, a Linux package that its package manager updates) — and keeps the author
 * in control: an update downloads in the background but never restarts the app by itself.
 * Installing happens on "Restart and install" or at the next normal quit.
 *
 * Everything it remembers (the channel, the automatic check, the notes of the last download)
 * lives in app-state.json, so a restart into the new version can show what changed.
 */

/** The logger `electron-updater` accepts; the app passes null, which silences it. */
export interface UpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
}

/** What the updater reports about a release; a structural subset of `UpdateInfo`. */
export interface UpdaterUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string | ReleaseNoteEntry[] | null
}

/** A download tick; a structural subset of `ProgressInfo`. */
export interface UpdaterProgress {
  percent: number
}

/** The updater events this service listens to, with the payload each one carries. */
export interface UpdaterEvents {
  'checking-for-update': () => void
  'update-available': (info: UpdaterUpdateInfo) => void
  'update-not-available': (info: UpdaterUpdateInfo) => void
  'download-progress': (progress: UpdaterProgress) => void
  'update-downloaded': (info: UpdaterUpdateInfo) => void
  error: (error: Error, message?: string) => void
}

/**
 * The part of `electron-updater`'s `AppUpdater` this service uses. Structural, so the real
 * `autoUpdater` satisfies it and tests pass an event emitter; nothing else in main imports the
 * package's types.
 */
export interface AppUpdaterLike {
  channel: string | null
  allowPrerelease: boolean
  allowDowngrade: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: UpdaterLogger | null
  on(event: 'checking-for-update', listener: UpdaterEvents['checking-for-update']): unknown
  on(event: 'update-available', listener: UpdaterEvents['update-available']): unknown
  on(event: 'update-not-available', listener: UpdaterEvents['update-not-available']): unknown
  on(event: 'download-progress', listener: UpdaterEvents['download-progress']): unknown
  on(event: 'update-downloaded', listener: UpdaterEvents['update-downloaded']): unknown
  on(event: 'error', listener: UpdaterEvents['error']): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

export interface UpdateServiceOptions {
  /** The real updater, or null when this build cannot update itself. */
  updater: AppUpdaterLike | null
  /** Why it cannot, in words the author can act on; required whenever `updater` is null. */
  unsupportedReason: string | null
  appState: AppStateStore
  currentVersion: string
  onChange: (state: UpdateState) => void
  now?: () => number
  schedule?: Schedule
}

const UNSUPPORTED_FALLBACK = 'This build does not update itself.'
/** An updater error is shown on one line of the Updates tab. */
const UPDATE_ERROR_MESSAGE_MAX = 300

export class UpdateService {
  private readonly updater: AppUpdaterLike | null
  private readonly appState: AppStateStore
  private readonly currentVersion: string
  private readonly onChange: (state: UpdateState) => void
  private readonly now: () => number
  private readonly schedule: Schedule

  private status: UpdateStatus
  private cancelTimer: (() => void) | null = null
  private started = false
  private disposed = false

  constructor(options: UpdateServiceOptions) {
    this.updater = options.updater
    this.appState = options.appState
    this.currentVersion = options.currentVersion
    this.onChange = options.onChange
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? defaultSchedule

    if (this.updater === null) {
      this.status = {
        state: 'unsupported',
        reason: options.unsupportedReason ?? UNSUPPORTED_FALLBACK
      }
    } else {
      this.status = { state: 'idle' }
      // Downloading is the background half; installing is the author's half, and never happens
      // while the app is running. A quit installs what is already on disk.
      this.updater.autoDownload = true
      this.updater.autoInstallOnAppQuit = true
      this.updater.logger = null
      this.applyChannel()
      this.wire(this.updater)
    }
  }

  state(): UpdateState {
    const settings = this.settings()
    return {
      currentVersion: this.currentVersion,
      channel: settings.channel,
      autoCheck: settings.autoCheck,
      status: this.status,
      installedNotes: settings.installedNotes,
      unseenNotes: this.unseenNotes(settings)
    }
  }

  /**
   * Whether the app came back up on a version it downloaded and has not shown the notes for:
   * derived from what is stored rather than remembered, so marking them seen is one write.
   */
  private unseenNotes(settings: UpdateSettings): boolean {
    return (
      settings.installedNotes !== null &&
      settings.installedNotes.version === this.currentVersion &&
      settings.lastSeenVersion !== this.currentVersion
    )
  }

  /**
   * Asks the feed now. A build that cannot update, a check or download already running, and an
   * update already on disk answer the state as it stands rather than starting a second one. A feed that cannot be
   * reached becomes the error status with its next step: never an unhandled rejection.
   */
  async check(): Promise<UpdateState> {
    const updater = this.updater
    if (updater === null) return this.state()
    const before = this.statusState()
    // A downloaded update stays `ready` until it is installed: asking again could only trade it
    // for an error while the author is offline. The next version is found after the restart.
    if (before === 'checking' || before === 'downloading' || before === 'ready') {
      return this.state()
    }
    this.setStatus({ state: 'checking' })
    try {
      await updater.checkForUpdates()
      // The updater answered without reporting anything (no release, or a check it skipped):
      // say so, rather than leaving "checking" on screen and refusing every later check.
      if (this.statusState() === 'checking') {
        this.setStatus({ state: 'upToDate', checkedAt: new Date(this.now()).toISOString() })
      }
    } catch (err) {
      this.setStatus(this.errorStatus(err))
    }
    return this.state()
  }

  /**
   * Switches channel and looks straight away, so the answer the author sees belongs to the
   * channel they just picked. Nothing is downgraded: a beta install keeps its build until a
   * newer stable one ships.
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    if (channel !== this.settings().channel) {
      this.write((settings) => ({ ...settings, channel }))
      this.applyChannel()
      this.emit()
    }
    return this.check()
  }

  /** Turns the automatic check on or off; the manual one works either way. */
  setAutoCheck(on: boolean): UpdateState {
    if (on === this.settings().autoCheck) return this.state()
    this.write((settings) => ({ ...settings, autoCheck: on }))
    if (on) this.arm(UPDATE_CHECK_DELAY_MS)
    else this.stopTimer()
    this.emit()
    return this.state()
  }

  /** The author has read what is new in the running version; it is not offered again. */
  markSeen(): UpdateState {
    if (this.settings().lastSeenVersion === this.currentVersion) return this.state()
    this.write((settings) => ({ ...settings, lastSeenVersion: this.currentVersion }))
    this.emit()
    return this.state()
  }

  /**
   * Restarts into the downloaded update. Only from `ready`: with nothing on disk the installer
   * would quit the app for nothing. The caller closes the project first — the installer starts
   * before this process exits.
   */
  install(): void {
    if (this.status.state !== 'ready' || this.updater === null) {
      throw new AppError('VALIDATION', 'No update is ready to install yet.')
    }
    this.updater.quitAndInstall(false, true)
  }

  /** Begins the automatic cycle: one check shortly after start, then one every few hours. */
  start(): void {
    this.started = true
    this.arm(UPDATE_CHECK_DELAY_MS)
  }

  /** The app is quitting: drop the timer. Nothing stored changes. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  /**
   * The status name, read through a call so no narrowing survives an `await`: the events fired
   * during a check change `this.status` under whatever the compiler decided before it.
   */
  private statusState(): UpdateStatus['state'] {
    return this.status.state
  }

  private settings(): UpdateSettings {
    return this.appState.get().updates
  }

  private write(fn: (settings: UpdateSettings) => UpdateSettings): void {
    this.appState.update((state) => ({ ...state, updates: fn(state.updates) }))
  }

  /**
   * Puts the stored channel on the updater. `allowDowngrade` is set after `channel`, because
   * assigning a channel turns it on, and MythScribe never moves an install backwards.
   */
  private applyChannel(): void {
    const updater = this.updater
    if (updater === null) return
    const { channel } = this.settings()
    updater.channel = updaterChannelFor(channel)
    updater.allowPrerelease = channel === 'beta'
    updater.allowDowngrade = false
  }

  private wire(updater: AppUpdaterLike): void {
    updater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    updater.on('update-available', (info) =>
      this.setStatus({ state: 'downloading', version: info.version, percent: 0 })
    )
    updater.on('download-progress', (progress) => {
      const current = this.status
      if (current.state !== 'downloading') return
      const percent = clampPercent(progress.percent)
      // Only whole percents move the renderer; a download pushes hundreds of these.
      if (percent === current.percent) return
      this.setStatus({ ...current, percent })
    })
    updater.on('update-not-available', () =>
      this.setStatus({ state: 'upToDate', checkedAt: new Date(this.now()).toISOString() })
    )
    updater.on('update-downloaded', (info) => {
      const notes: ReleaseNotes = {
        version: info.version,
        date: info.releaseDate ?? null,
        text: releaseNotesText(info.releaseNotes)
      }
      // Stored as the pending version's notes, which become "what's new" after the restart.
      // Never for the running version: that would overwrite the notes being shown right now.
      if (info.version !== this.currentVersion) {
        this.write((settings) => ({ ...settings, installedNotes: notes }))
      }
      this.setStatus({ state: 'ready', version: info.version, notes })
    })
    updater.on('error', (error) => this.setStatus(this.errorStatus(error)))
  }

  private errorStatus(err: unknown): UpdateStatus {
    const raw = err instanceof Error ? err.message : String(err)
    // The updater appends the response headers and a stack to its messages; the first line is
    // the cause, and the only part an author can read.
    const message = (raw.split('\n')[0] ?? '').trim().slice(0, UPDATE_ERROR_MESSAGE_MAX)
    return { state: 'error', message, nextStep: UPDATE_ERROR_NEXT_STEP }
  }

  private setStatus(status: UpdateStatus): void {
    if (sameStatus(this.status, status)) return
    this.status = status
    this.emit()
  }

  private emit(): void {
    if (this.disposed) return
    this.onChange(this.state())
  }

  /** Arms the next automatic check, if this build checks by itself and the cycle has started. */
  private arm(ms: number): void {
    if (this.disposed || this.updater === null || !this.started || !this.settings().autoCheck) {
      return
    }
    this.stopTimer()
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.check().then(() => this.arm(UPDATE_CHECK_INTERVAL_MS))
    }, ms)
  }

  private stopTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

/** Whether nothing changed, so an unchanged status never pushes an event. */
function sameStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
