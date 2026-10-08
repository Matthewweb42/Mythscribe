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
import { OPEN_LOCK_FILE, OpenLock } from './openLock'
import { seedSettings, seedSkeleton } from './seed'
import type { WorkingCopy } from './workingCopy'

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
    public info: ProjectInfo,
    private readonly lock: OpenLock | null = null,
    /** Set when the project is in a cloud-synced folder: SQLite works on this local copy. */
    readonly workingCopy: WorkingCopy | null = null
  ) {}

  /**
   * Where per-computer files go (the crash journal, F-8.3): the project folder, or beside the
   * working copy for a project in a cloud-synced folder.
   */
  get localFolder(): string {
    return this.workingCopy?.localFolder ?? this.folder
  }

  /**
   * Closes the database and releases the open marker. A project in a cloud-synced folder is
   * copied back first, while the marker still says this computer has it; a failed copy is
   * logged and the working copy stays marked as ahead, so the next open copies it back.
   */
  close(): void {
    const copy = this.workingCopy
    let clean = true
    if (copy) {
      try {
        if (copy.hasChanges(this.connection.sqlite)) copy.syncNow(this.connection.sqlite)
      } catch (err) {
        clean = false
        console.warn('Could not copy the project back to its cloud folder; it is kept here', err)
      }
    }
    let closed = false
    try {
      this.connection.close()
      closed = true
    } finally {
      this.lock?.release()
      copy?.finish(clean && closed)
    }
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

/** How a project starts: the starter skeleton (F-1.3) or not, and what to write into it first. */
export interface CreateProjectOptions {
  /**
   * `false` (F-1.6) seeds only the three sections, for a project whose tree comes from
   * elsewhere (a converted v0 project, a manuscript imported from the welcome screen).
   */
  skeleton?: boolean
  /**
   * Writes the project's first content once the database is seeded (F-12.2: the reviewed
   * import). A throw undoes the whole create, folder included, as any other failed create does,
   * so a refused import never leaves a half-made project behind.
   */
  fill?: (db: Connection['orm']) => void
  /**
   * For a folder in a cloud-synced location (2026-10-08): prepares the local working copy the
   * database is created in, once the open marker is held. The new project is copied into the
   * folder before the create answers; a copy that fails undoes the create.
   */
  workingCopy?: (folder: string) => WorkingCopy | null
}

export function createProject(
  folder: string,
  name: string,
  format: NovelFormat,
  { skeleton = true, fill, workingCopy: prepare }: CreateProjectOptions = {}
): ProjectSession {
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
  let lock: OpenLock | null = null
  let copy: WorkingCopy | null = null
  try {
    fs.mkdirSync(path.join(folder, ASSETS_DIR), { recursive: true })
    lock = OpenLock.acquire(folder)
    copy = prepare?.(folder) ?? null
    connection = openDatabase(copy?.dbFile ?? path.join(folder, DB_FILE))
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
      const rows = seedSkeleton(format, now)
      insertNodes(tx, skeleton ? rows : rows.filter((row) => row.sectionType != null))
      tx.insert(settings).values(seedSettings(format)).run()
    })
    fill?.(connection.orm)
    copy?.syncNow(connection.sqlite)
    return new ProjectSession(
      folder,
      connection,
      toInfo(row, folder, connection.schemaVersion),
      lock,
      copy
    )
  } catch (err) {
    connection?.close()
    lock?.release()
    copy?.discard()
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
  fs.rmSync(path.join(folder, OPEN_LOCK_FILE), { force: true })
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

/**
 * Opens a project. `workingCopy` (2026-10-08) prepares the local working copy for a folder in a
 * cloud-synced location once the open marker is held; SQLite then opens that copy instead of the
 * database in the folder. Null (or absent) opens the folder's database in place.
 */
export function openProject(
  input: string,
  workingCopy?: (folder: string) => WorkingCopy | null
): ProjectSession {
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

  const lock = OpenLock.acquire(folder)
  let connection: Connection
  let copy: WorkingCopy | null = null
  try {
    copy = workingCopy?.(folder) ?? null
    connection = openDatabase(copy?.dbFile ?? path.join(folder, DB_FILE))
  } catch (err) {
    copy?.abandon()
    lock.release()
    throw err
  }
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
      toInfo({ ...row, lastOpened }, folder, connection.schemaVersion),
      lock,
      copy
    )
  } catch (err) {
    connection.close()
    copy?.abandon()
    lock.release()
    throw err
  }
}
