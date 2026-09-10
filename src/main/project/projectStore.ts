import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { NovelFormat, ProjectInfo } from '@shared/ipc/contract'
import { openDatabase, type Connection } from '../db/connection'
import { project as projectTable } from '../db/schema'
import { AppError } from '../ipc/errors'

/**
 * A project is a folder `<Name>.mythscribe/` containing `project.db` and `assets/`.
 * Copying the folder copies the project. (FEATURES.md F-8.1)
 */
export const PROJECT_EXTENSION = '.mythscribe'
export const DB_FILE = 'project.db'
export const ASSETS_DIR = 'assets'

/** Characters illegal in file names on Windows, plus all control characters. */
const ILLEGAL = /[<>:"/\\|?*\p{Cc}]/gu

export function sanitizeName(name: string): string {
  const cleaned = name.replace(ILLEGAL, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  return cleaned.length > 0 ? cleaned : 'Untitled'
}

export function projectFolderFor(directory: string, name: string): string {
  return path.join(directory, `${sanitizeName(name)}${PROJECT_EXTENSION}`)
}

/** Accepts the project folder or the `project.db` inside it. */
export function resolveProjectFolder(p: string): string {
  return path.basename(p) === DB_FILE ? path.dirname(p) : p
}

export function isProjectFolder(folder: string): boolean {
  return fs.existsSync(path.join(folder, DB_FILE))
}

export class ProjectSession {
  constructor(
    readonly folder: string,
    readonly connection: Connection,
    public info: ProjectInfo
  ) {}

  close(): void {
    this.connection.close()
  }
}

type ProjectRow = typeof projectTable.$inferSelect

function toInfo(row: ProjectRow, folder: string, schemaVersion: number): ProjectInfo {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    path: folder,
    created: row.created,
    modified: row.modified,
    lastOpened: row.lastOpened,
    schemaVersion
  }
}

export function createProject(folder: string, name: string, format: NovelFormat): ProjectSession {
  if (fs.existsSync(folder)) {
    if (isProjectFolder(folder)) {
      throw new AppError('ALREADY_EXISTS', `A project already exists at ${folder}`, { folder })
    }
    if (fs.readdirSync(folder).length > 0) {
      throw new AppError('ALREADY_EXISTS', `Folder is not empty: ${folder}`, { folder })
    }
  }
  fs.mkdirSync(path.join(folder, ASSETS_DIR), { recursive: true })

  const connection = openDatabase(path.join(folder, DB_FILE))
  try {
    const now = new Date().toISOString()
    const row: ProjectRow = {
      id: randomUUID(),
      name: name.trim(),
      format,
      created: now,
      modified: now,
      lastOpened: now
    }
    connection.orm.insert(projectTable).values(row).run()
    return new ProjectSession(folder, connection, toInfo(row, folder, connection.schemaVersion))
  } catch (err) {
    connection.close()
    throw err
  }
}

export function openProject(input: string): ProjectSession {
  const folder = resolveProjectFolder(input)
  if (!isProjectFolder(folder)) {
    throw new AppError('NOT_FOUND', `No MythScribe project at ${folder}`, { folder })
  }
  fs.mkdirSync(path.join(folder, ASSETS_DIR), { recursive: true })

  const connection = openDatabase(path.join(folder, DB_FILE))
  try {
    const row = connection.orm.select().from(projectTable).get()
    if (!row) {
      throw new AppError('IO', `Project database has no project record: ${folder}`, { folder })
    }
    const lastOpened = new Date().toISOString()
    connection.orm.update(projectTable).set({ lastOpened }).where(eq(projectTable.id, row.id)).run()
    return new ProjectSession(
      folder,
      connection,
      toInfo({ ...row, lastOpened }, folder, connection.schemaVersion)
    )
  } catch (err) {
    connection.close()
    throw err
  }
}
