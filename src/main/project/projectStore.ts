import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { NovelFormat, ProjectInfo } from '@shared/ipc/contract'
import { openDatabase, type Connection } from '../db/connection'
import { project as projectTable, settings } from '../db/schema'
import { AppError } from '../ipc/errors'
import { insertNodes } from '../tree/treeStore'
import { isLegacyDatabase } from './legacy'
import { seedSettings, seedSkeleton } from './seed'

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
  const createdFolder = !fs.existsSync(folder)

  let connection: Connection | null = null
  try {
    fs.mkdirSync(path.join(folder, ASSETS_DIR), { recursive: true })
    connection = openDatabase(path.join(folder, DB_FILE))
    const now = new Date().toISOString()
    const row: ProjectRow = {
      id: randomUUID(),
      name: name.trim(),
      format,
      created: now,
      modified: now,
      lastOpened: now
    }
    connection.orm.transaction((tx) => {
      tx.insert(projectTable).values(row).run()
      insertNodes(tx, seedSkeleton(format, now))
      tx.insert(settings).values(seedSettings(format)).run()
    })
    return new ProjectSession(folder, connection, toInfo(row, folder, connection.schemaVersion))
  } catch (err) {
    connection?.close()
    removeCreateLeftovers(folder, createdFolder)
    throw err
  }
}

/**
 * A failed create must not leave a half-made project behind, or the retry hits ALREADY_EXISTS.
 * A folder we made is removed whole; a pre-existing (empty) folder is returned to empty.
 */
function removeCreateLeftovers(folder: string, createdFolder: boolean): void {
  if (createdFolder) {
    fs.rmSync(folder, { recursive: true, force: true })
    return
  }
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(path.join(folder, `${DB_FILE}${suffix}`), { force: true })
  }
  const assets = path.join(folder, ASSETS_DIR)
  if (fs.existsSync(assets) && fs.readdirSync(assets).length === 0) fs.rmdirSync(assets)
}

export type ProjectLocation =
  { kind: 'v1'; folder: string } | { kind: 'legacy'; source: string; dbFile: string }

/**
 * Works out what the author pointed at: a project folder, the `project.db` inside one, or a v0
 * single-file `.mythscribe` database. Throws NOT_FOUND with a next step for anything else and IO
 * when the database is not SQLite.
 */
export function locateProject(input: string): ProjectLocation {
  let stat: fs.Stats
  try {
    stat = fs.statSync(input)
  } catch {
    throw new AppError('NOT_FOUND', `No MythScribe project at ${input}`, { path: input })
  }
  let candidate: ProjectLocation
  if (stat.isDirectory()) {
    if (!isProjectFolder(input)) {
      throw new AppError('NOT_FOUND', `${input} has no ${DB_FILE}`, { path: input })
    }
    candidate = { kind: 'v1', folder: input }
  } else if (path.basename(input).toLowerCase() === DB_FILE) {
    // The OS file dialog matches extensions case-insensitively, so accept `Project.DB` too.
    candidate = { kind: 'v1', folder: path.dirname(input) }
  } else if (path.extname(input).toLowerCase() === PROJECT_EXTENSION) {
    return { kind: 'legacy', source: input, dbFile: input }
  } else {
    throw new AppError(
      'NOT_FOUND',
      `Not a MythScribe project: choose ${DB_FILE} inside a ${PROJECT_EXTENSION} folder`,
      { path: input }
    )
  }
  // A v0 folder layout also had a project.db; only its tables tell the two apart.
  const dbFile = path.join(candidate.folder, DB_FILE)
  if (isLegacyDatabase(dbFile)) return { kind: 'legacy', source: candidate.folder, dbFile }
  return candidate
}

export function openProject(input: string): ProjectSession {
  const location = locateProject(input)
  if (location.kind === 'legacy') {
    throw new AppError(
      'IO',
      'This project was saved by an older MythScribe (v0). This version cannot open it yet.',
      { path: location.source }
    )
  }
  const folder = location.folder
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
