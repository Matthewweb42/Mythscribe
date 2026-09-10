import type { NovelFormat, ProjectInfo } from '@shared/ipc/contract'
import { AppError } from '../ipc/errors'
import { createProject, openProject, type ProjectSession } from './projectStore'

type Listener = (info: ProjectInfo | null) => void

/** Owns the single open project and notifies listeners when it changes. */
export class ProjectManager {
  private session: ProjectSession | null = null
  private readonly listeners = new Set<Listener>()

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
    const next = openProject(folder)
    this.replace(next)
    return next.info
  }

  close(): void {
    if (!this.session) return
    this.session.close()
    this.session = null
    this.notify()
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private replace(next: ProjectSession): void {
    this.session?.close()
    this.session = next
    this.notify()
  }

  private notify(): void {
    const info = this.current()
    for (const l of this.listeners) l(info)
  }
}
