import path from 'node:path'
import type { NovelFormat, ProjectInfo } from '@shared/ipc/contract'
import { AppError } from '../ipc/errors'
import { DB_FILE, createProject, openProject, type ProjectSession } from './projectStore'

type Listener = (info: ProjectInfo | null) => void
type BeforeCloseListener = (session: ProjectSession) => void

/** Owns the single open project and notifies listeners when it changes. */
export class ProjectManager {
  private session: ProjectSession | null = null
  private readonly listeners = new Set<Listener>()
  private readonly beforeClose = new Set<BeforeCloseListener>()

  current(): ProjectInfo | null {
    return this.session?.info ?? null
  }

  /** For features that need the database; throws NO_PROJECT when nothing is open. */
  require(): ProjectSession {
    if (!this.session) throw new AppError('NO_PROJECT', 'No project is open')
    return this.session
  }

  create(folder: string, name: string, format: NovelFormat): ProjectInfo {
    const next = createProject(folder, name, format)
    this.replace(next)
    return next.info
  }

  open(folder: string): ProjectInfo {
    this.closeIfOpen(folder)
    const next = openProject(folder)
    this.replace(next)
    return next.info
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
