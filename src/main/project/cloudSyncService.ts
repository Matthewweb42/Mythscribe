import {
  CLOUD_SYNC_INTERVAL_MS,
  CLOUD_SYNC_RETRY_MS,
  type CloudSyncStatus
} from '@shared/cloudSync'
import type { ProjectInfo } from '@shared/ipc/contract'
import { defaultSchedule, type Schedule } from '../schedule'
import type { ProjectSession } from './projectStore'

/**
 * Copies the open project's working copy back to its cloud folder while it is open
 * (2026-10-08; details decided by Claude, unconfirmed): every `CLOUD_SYNC_INTERVAL_MS` when
 * anything changed (SQLite's `total_changes()` against the last copy, the signal backups use),
 * at once after an open that carried changes from before (a crash, a failed copy), after an
 * import, and when the renderer asks before a close. The copy on close itself is
 * `ProjectSession.close`, so every way a project closes copies it back. A failed copy is retried
 * with a doubling delay (from `CLOUD_SYNC_RETRY_MS` up to the interval) and reported as
 * `failed`, never as a modal.
 */

export interface CloudSyncProjects {
  current(): ProjectInfo | null
  require(): ProjectSession
}

export interface CloudSyncServiceOptions {
  projects: CloudSyncProjects
  onChange: (status: CloudSyncStatus | null) => void
  schedule?: Schedule
  intervalMs?: number
}

export class CloudSyncService {
  private readonly projects: CloudSyncProjects
  private readonly onChange: (status: CloudSyncStatus | null) => void
  private readonly schedule: Schedule
  private readonly intervalMs: number

  private session: ProjectSession | null = null
  private running: Promise<void> | null = null
  private error: string | null = null
  private failures = 0
  private cancelTimer: (() => void) | null = null
  private disposed = false

  constructor(options: CloudSyncServiceOptions) {
    this.projects = options.projects
    this.onChange = options.onChange
    this.schedule = options.schedule ?? defaultSchedule
    this.intervalMs = options.intervalMs ?? CLOUD_SYNC_INTERVAL_MS
  }

  /** null unless the open project is in a cloud-synced folder. */
  status(): CloudSyncStatus | null {
    const copy = this.session?.workingCopy
    if (!copy) return null
    return {
      provider: copy.provider,
      state: this.running !== null ? 'copying' : this.error !== null ? 'failed' : 'synced',
      lastSyncedAt: copy.lastSyncedAt,
      error: this.error,
      conflictCopy: copy.conflictCopy,
      conflictCopyHolds: copy.conflictCopyHolds
    }
  }

  /** A project opened or was created: start the schedule, or copy at once if it carried changes. */
  projectOpened(): void {
    this.stopTimer()
    this.error = null
    this.failures = 0
    const session = this.projects.current() ? this.projects.require() : null
    this.session = session?.workingCopy ? session : null
    if (this.session?.workingCopy?.carriesChanges) {
      void this.run()
    } else {
      this.arm(this.intervalMs)
    }
    this.emit()
  }

  /** The project is closing; its session copies itself back. */
  projectClosing(): void {
    this.stopTimer()
    this.session = null
  }

  projectClosed(): void {
    this.stopTimer()
    this.session = null
    this.error = null
    this.emit()
  }

  /**
   * Copies now if anything is waiting (or the last copy failed) and answers the status after it;
   * the renderer calls this before closing the project or the window and asks the author what
   * to do when it comes back `failed`. Never throws.
   */
  async syncNow(): Promise<CloudSyncStatus | null> {
    // A copy already running took its snapshot before the latest saves; wait, then copy again.
    if (this.running !== null) await this.running
    await this.run()
    return this.status()
  }

  /** Something big just landed (an import): copy it soon instead of in up to three minutes. */
  changed(): void {
    if (this.session !== null) void this.run()
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  private run(): Promise<void> {
    if (this.running !== null) return this.running
    const session = this.session
    const copy = session?.workingCopy
    if (!session || !copy) return Promise.resolve()
    if (!copy.hasChanges(session.connection.sqlite) && this.error === null) {
      this.arm(this.intervalMs)
      return Promise.resolve()
    }
    this.stopTimer()
    const work = (async () => {
      try {
        await copy.sync(session.connection.sqlite)
        this.error = null
        this.failures = 0
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
        this.failures++
      }
    })()
    this.running = work.finally(() => {
      this.running = null
      if (this.session !== session) return
      this.arm(
        this.error === null
          ? this.intervalMs
          : Math.min(this.intervalMs, CLOUD_SYNC_RETRY_MS * 2 ** (this.failures - 1))
      )
      this.emit()
    })
    this.emit()
    return this.running
  }

  private arm(ms: number): void {
    this.stopTimer()
    if (this.disposed || this.session === null) return
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.run()
    }, ms)
  }

  private stopTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private emit(): void {
    this.onChange(this.status())
  }
}
