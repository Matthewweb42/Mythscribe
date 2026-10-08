import fs from 'node:fs'
import path from 'node:path'
import {
  backupFileName,
  backupProjectName,
  restoredFolderName,
  type BackupEntry,
  type BackupSettings,
  type BackupSettingsPatch,
  type BackupState
} from '@shared/backups'
import type { ProjectInfo } from '@shared/ipc/contract'
import type { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import { PROJECT_EXTENSION, sanitizeName, type ProjectSession } from '../project/projectStore'
import { defaultSchedule, type Schedule } from '../schedule'
import {
  createBackupArchive,
  extractBackup,
  listBackups,
  projectBackupDir,
  pruneBackups
} from './backupArchive'

/**
 * The one owner of automatic backups (F-8.4). Built like `UpdateService`: settings in
 * app-state.json, a `Schedule` for the timer, and `onChange` → `backups:changed` for anything it
 * does by itself. It backs the open project up on the schedule and when it closes, but only when
 * the project changed (SQLite's `total_changes()` on the session's connection, measured from
 * when it opened or was last backed up) or has no backup yet; "Back up now" always backs up.
 *
 * Automatic failures never get in the way of closing or quitting: they are caught, kept as
 * `lastError` until the next success, and pushed so the renderer can say so.
 */

/** What the service needs of the project manager. */
export interface BackupProjects {
  current(): ProjectInfo | null
  require(): ProjectSession
}

export interface BackupServiceOptions {
  appState: AppStateStore
  projects: BackupProjects
  /** Where backups go unless the author chose a folder. */
  defaultFolder: string
  onChange: (state: BackupState) => void
  schedule?: Schedule
  now?: () => Date
}

interface Tracked {
  session: ProjectSession
  /** `total_changes()` when the project opened or was last backed up. */
  baseline: number
}

const MINUTE_MS = 60_000

export class BackupService {
  private readonly appState: AppStateStore
  private readonly projects: BackupProjects
  private readonly defaultFolder: string
  private readonly onChange: (state: BackupState) => void
  private readonly schedule: Schedule
  private readonly now: () => Date

  private tracked: Tracked | null = null
  private cancelTimer: (() => void) | null = null
  private lastError: string | null = null
  private disposed = false

  constructor(options: BackupServiceOptions) {
    this.appState = options.appState
    this.projects = options.projects
    this.defaultFolder = options.defaultFolder
    this.onChange = options.onChange
    this.schedule = options.schedule ?? defaultSchedule
    this.now = options.now ?? (() => new Date())
  }

  state(): BackupState {
    const backups = this.currentBackups()
    return {
      settings: this.settings(),
      folder: this.folder(),
      defaultFolder: this.defaultFolder,
      backups,
      lastBackupAt: backups[0]?.createdAt ?? null,
      lastError: this.lastError
    }
  }

  setSettings(patch: BackupSettingsPatch): BackupState {
    const before = this.settings()
    const next: BackupSettings = {
      enabled: patch.enabled ?? before.enabled,
      folder: patch.folder === null ? null : before.folder,
      intervalMinutes: patch.intervalMinutes ?? before.intervalMinutes,
      onClose: patch.onClose ?? before.onClose,
      keep: patch.keep ?? before.keep
    }
    this.write(next)
    if (next.enabled !== before.enabled || next.intervalMinutes !== before.intervalMinutes) {
      this.arm()
    }
    this.emit()
    return this.state()
  }

  /** The folder the author picked in main's own dialog. */
  setFolder(folder: string): BackupState {
    this.write({ ...this.settings(), folder })
    this.emit()
    return this.state()
  }

  /** A project opened (or was created): measure from here and start the schedule. */
  projectOpened(): void {
    const session = this.projects.require()
    this.tracked = { session, baseline: changesOf(session) }
    this.arm()
    this.emit()
  }

  /**
   * The project is about to close (its database is still open): back it up if it changed and
   * the author wants on-close backups. Never throws.
   */
  projectClosing(session: ProjectSession): void {
    this.stopTimer()
    const tracked = this.tracked
    this.tracked = null
    const settings = this.settings()
    if (!settings.enabled || !settings.onClose) return
    this.runAutomatic(session, tracked?.session === session ? tracked.baseline : null)
  }

  /** The project closed: the tab has no backups to list now. */
  projectClosed(): void {
    this.tracked = null
    this.stopTimer()
    this.emit()
  }

  /** Backs the open project up now, changed or not. Throws with the cause. */
  backupNow(): BackupState {
    this.backup(this.projects.require())
    return this.state()
  }

  /** `file` if it is one of the open project's backups; NOT_FOUND otherwise. */
  listedBackup(file: string): BackupEntry {
    const entry = this.currentBackups().find((b) => b.file === file)
    if (entry === undefined) {
      throw new AppError('NOT_FOUND', 'That backup is no longer in the backup folder.')
    }
    return entry
  }

  /**
   * Unpacks `zip` into a new folder under `parent` — `<name> (restored YYYY-MM-DD HHmm)`, with
   * ` 2`, ` 3`… when that exists — and answers the folder. Nothing is overwritten.
   */
  extractToNewProject(zip: string, parent: string): string {
    const name = sanitizeName(backupProjectName(path.basename(zip)))
    const base = restoredFolderName(name, this.now()).slice(0, -PROJECT_EXTENSION.length)
    let target = path.join(parent, `${base}${PROJECT_EXTENSION}`)
    for (let n = 2; fs.existsSync(target); n++) {
      target = path.join(parent, `${base} ${n}${PROJECT_EXTENSION}`)
    }
    extractBackup(zip, target)
    return target
  }

  /**
   * Restores `zip` as a new project under `parent` and opens it with `open` (the manager, so
   * migrations run and an older backup opens in a newer app). A copy that will not open is
   * removed again, so a failed restore leaves nothing behind.
   */
  restore(zip: string, parent: string, open: (folder: string) => ProjectInfo): ProjectInfo {
    const folder = this.extractToNewProject(zip, parent)
    try {
      return open(folder)
    } catch (err) {
      fs.rmSync(folder, { recursive: true, force: true })
      throw err
    }
  }

  /** The app is quitting: drop the timer. The on-close backup still runs from `projectClosing`. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  private settings(): BackupSettings {
    return this.appState.get().backups
  }

  private write(settings: BackupSettings): void {
    this.appState.update((state) => ({ ...state, backups: settings }))
  }

  private folder(): string {
    return this.settings().folder ?? this.defaultFolder
  }

  private dirFor(session: ProjectSession): string {
    return this.dirForProject(session.info)
  }

  /** One project's backups folder, open or not (F-8.7: the pre-migration backup goes here too). */
  dirForProject(project: { id: string; name: string }): string {
    return projectBackupDir(this.folder(), sanitizeName(project.name), project.id)
  }

  private currentBackups(): BackupEntry[] {
    if (this.projects.current() === null) return []
    try {
      return listBackups(this.dirFor(this.projects.require()))
    } catch {
      // A folder on a drive that is not there lists nothing; the next backup reports the cause.
      return []
    }
  }

  private backup(session: ProjectSession): void {
    const dir = this.dirFor(session)
    const now = this.now()
    const file = path.join(dir, backupFileName(sanitizeName(session.info.name), now))
    createBackupArchive(session, file, this.folder(), now)
    pruneBackups(dir, this.settings().keep)
    if (this.tracked?.session === session) this.tracked.baseline = changesOf(session)
    this.lastError = null
    this.emit()
  }

  /** A scheduled or on-close backup: only when needed, and a failure is recorded, not thrown. */
  private runAutomatic(session: ProjectSession, baseline: number | null): void {
    try {
      const changed = baseline === null || changesOf(session) > baseline
      if (!changed && listBackups(this.dirFor(session)).length > 0) return
      this.backup(session)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emit()
    }
  }

  private arm(): void {
    this.stopTimer()
    if (this.disposed || this.tracked === null || !this.settings().enabled) return
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      const tracked = this.tracked
      if (tracked !== null && this.settings().enabled) {
        this.runAutomatic(tracked.session, tracked.baseline)
      }
      this.arm()
    }, this.settings().intervalMinutes * MINUTE_MS)
  }

  private stopTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private emit(): void {
    if (this.disposed) return
    this.onChange(this.state())
  }
}

/** Rows changed through this connection since it opened. */
function changesOf(session: ProjectSession): number {
  const n: unknown = session.connection.sqlite.prepare('SELECT total_changes()').pluck().get()
  return typeof n === 'number' ? n : 0
}
