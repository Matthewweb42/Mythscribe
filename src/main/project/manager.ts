import path from 'node:path'
import type { CloudProvider } from '@shared/cloudSync'
import type { NovelFormat, ProjectInfo } from '@shared/ipc/contract'
import { AppError } from '../ipc/errors'
import { cloudProviderFor } from './cloudFolder'
import {
  DB_FILE,
  createProject,
  openProject,
  type BackupDirFor,
  type CreateProjectOptions,
  type ProjectSession
} from './projectStore'
import { WorkingCopy } from './workingCopy'

type Listener = (info: ProjectInfo | null) => void
type BeforeCloseListener = (session: ProjectSession) => void

export interface ProjectManagerOptions {
  /**
   * Where working copies of projects in cloud-synced folders live (2026-10-08): userData's
   * `working/` in the app. Absent, every project opens in place (the unit tests).
   */
  workingRoot?: () => string
  /** Which sync app holds a folder; `cloudProviderFor` unless a test says otherwise. */
  detectCloud?: (folder: string) => CloudProvider | null
  /** Where a project's backups go (F-8.7: the pre-migration backup); absent, none is written. */
  backupDirFor?: BackupDirFor
}

/** Owns the single open project and notifies listeners when it changes. */
export class ProjectManager {
  private session: ProjectSession | null = null
  private readonly listeners = new Set<Listener>()
  private readonly beforeClose = new Set<BeforeCloseListener>()
  private readonly workingRoot: (() => string) | null
  private readonly detectCloud: (folder: string) => CloudProvider | null
  private readonly backupDirFor: BackupDirFor | undefined

  constructor(options: ProjectManagerOptions = {}) {
    this.workingRoot = options.workingRoot ?? null
    this.backupDirFor = options.backupDirFor
    this.detectCloud = options.detectCloud ?? ((folder) => cloudProviderFor(folder))
  }

  current(): ProjectInfo | null {
    return this.session?.info ?? null
  }

  /** For features that need the database; throws NO_PROJECT when nothing is open. */
  require(): ProjectSession {
    if (!this.session) throw new AppError('NO_PROJECT', 'No project is open')
    return this.session
  }

  create(
    folder: string,
    name: string,
    format: NovelFormat,
    options: CreateProjectOptions = {}
  ): ProjectInfo {
    const next = createProject(folder, name, format, {
      ...options,
      workingCopy: (target) => this.workingCopyFor(target, 'create')
    })
    this.replace(next)
    return next.info
  }

  open(folder: string): ProjectInfo {
    this.closeIfOpen(folder)
    const next = openProject(
      folder,
      (target) => this.workingCopyFor(target, 'open'),
      this.backupDirFor
    )
    this.replace(next)
    return next.info
  }

  /** A local working copy for a project in a cloud-synced folder; null for a plain folder. */
  private workingCopyFor(folder: string, mode: 'open' | 'create'): WorkingCopy | null {
    if (this.workingRoot === null) return null
    const provider = this.detectCloud(folder)
    if (provider === null) return null
    return mode === 'open'
      ? WorkingCopy.open(folder, this.workingRoot(), provider)
      : WorkingCopy.create(folder, this.workingRoot(), provider)
  }

  /**
   * Closes the open project when `input` (its folder or its project.db) names it. The database is
   * held with an exclusive lock, so reopening it, or even reading it to locate it, needs this first.
   */
  closeIfOpen(input: string): void {
    const target = path.basename(input).toLowerCase() === DB_FILE ? path.dirname(input) : input
    if (this.session && path.resolve(this.session.folder) === path.resolve(target)) this.close()
  }

  close(): void {
    if (!this.session) return
    this.notifyBeforeClose(this.session)
    this.session.close()
    this.session = null
    this.notify()
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Runs right before the open project's database closes — on close, and when another project
   * replaces it — while the session can still be read (F-8.4: the on-close backup). A listener
   * that throws is logged and skipped: closing always goes ahead.
   */
  onBeforeClose(listener: BeforeCloseListener): () => void {
    this.beforeClose.add(listener)
    return () => this.beforeClose.delete(listener)
  }

  private notifyBeforeClose(session: ProjectSession): void {
    for (const l of this.beforeClose) {
      try {
        l(session)
      } catch (err) {
        console.warn('A before-close step failed; closing anyway', err)
      }
    }
  }

  private replace(next: ProjectSession): void {
    if (this.session) this.notifyBeforeClose(this.session)
    this.session?.close()
    this.session = next
    this.notify()
  }

  private notify(): void {
    const info = this.current()
    for (const l of this.listeners) l(info)
  }
}
