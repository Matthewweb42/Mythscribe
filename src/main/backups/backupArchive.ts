import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BACKUP_MAX_UNPACKED_BYTES,
  backupsToPrune,
  parseBackupFileName,
  projectBackupDirName,
  projectBackupDirSuffix,
  type BackupEntry
} from '@shared/backups'
import { AppError } from '../ipc/errors'
import { OPEN_LOCK_FILE } from '../project/openLock'
import { DB_FILE, type ProjectSession } from '../project/projectStore'
import { RECOVERY_DIR } from '../project/recoveryJournal'
import { readZipDirectory, readZipEntry, zipBuffer, type ZipEntryInput } from './zip'

/**
 * Making, listing, pruning, and unpacking backups (F-8.4). A backup is the whole project folder
 * as one zip: a consistent snapshot of the database (`VACUUM INTO`, so one file and no WAL) as
 * `project.db`, and every other file in the folder except the live database files, the crash
 * journal (it belongs to this run), and temp files. Restoring never overwrites anything: it
 * unpacks into a folder that does not exist yet.
 */

/** Top-level names that never go into a backup: the live database is replaced by the snapshot. */
const EXCLUDED_TOP = new Set([
  DB_FILE,
  `${DB_FILE}-wal`,
  `${DB_FILE}-shm`,
  OPEN_LOCK_FILE,
  RECOVERY_DIR
])

/** Formats that are compressed already; deflating them again only costs time. */
const STORED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.zip',
  '.docx',
  '.epub',
  '.pdf'
])

/** The first bytes of every SQLite database file. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

const NOT_A_BACKUP = 'This file is not a MythScribe backup'

export type BackupSource = Pick<ProjectSession, 'folder' | 'connection'>

/**
 * Zips the project into `destZip`, atomically (a `.tmp` sibling, then a rename). `exclude` is a
 * folder never to include — the backup folder itself, if the author put it inside the project.
 */
export function createBackupArchive(
  session: BackupSource,
  destZip: string,
  exclude: string | null = null,
  modified: Date = new Date()
): void {
  const snapshot = path.join(os.tmpdir(), `mythscribe-backup-${randomUUID()}.db`)
  const tmp = `${destZip}.tmp`
  try {
    // VACUUM INTO refuses an existing target, so the name is fresh every time.
    session.connection.sqlite.prepare('VACUUM INTO ?').run(snapshot)
    const entries: ZipEntryInput[] = [{ name: DB_FILE, data: fs.readFileSync(snapshot) }]
    collectFiles(session.folder, '', exclude === null ? null : path.resolve(exclude), entries)
    fs.mkdirSync(path.dirname(destZip), { recursive: true })
    fs.writeFileSync(tmp, zipBuffer(entries, modified))
    fs.renameSync(tmp, destZip)
  } finally {
    fs.rmSync(snapshot, { force: true })
    fs.rmSync(tmp, { force: true })
  }
}

function collectFiles(
  root: string,
  relative: string,
  exclude: string | null,
  out: ZipEntryInput[]
): void {
  const dir = path.join(root, relative)
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (relative === '' && EXCLUDED_TOP.has(item.name)) continue
    if (item.name.endsWith('.tmp')) continue
    const full = path.join(dir, item.name)
    if (exclude !== null && (full === exclude || full.startsWith(`${exclude}${path.sep}`))) continue
    const name = relative === '' ? item.name : `${relative}/${item.name}`
    // Links are left out: following one could pull in anything on the machine.
    if (item.isDirectory()) collectFiles(root, name, exclude, out)
    else if (item.isFile()) {
      const store = STORED_EXTENSIONS.has(path.extname(item.name).toLowerCase())
      out.push({ name, data: fs.readFileSync(full), store })
    }
  }
}

/**
 * The folder one project's backups live in: `<name> (<id8>)` under `root`. A folder already
 * keyed by this id wins, so renaming the project keeps its backups together.
 */
export function projectBackupDir(root: string, safeName: string, projectId: string): string {
  const suffix = ` ${projectBackupDirSuffix(projectId)}`
  if (fs.existsSync(root)) {
    const existing = fs
      .readdirSync(root, { withFileTypes: true })
      .find((item) => item.isDirectory() && item.name.endsWith(suffix))
    if (existing !== undefined) return path.join(root, existing.name)
  }
  return path.join(root, projectBackupDirName(safeName, projectId))
}

/** The backups in `dir`, newest first. Files that are not named like a backup are not ours. */
export function listBackups(dir: string): BackupEntry[] {
  if (!fs.existsSync(dir)) return []
  const entries: { entry: BackupEntry; time: number }[] = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile()) continue
    const date = parseBackupFileName(item.name)
    if (date === null) continue
    const file = path.join(dir, item.name)
    const bytes = fs.statSync(file).size
    entries.push({
      entry: { file, name: item.name, createdAt: date.toISOString(), bytes },
      time: date.getTime()
    })
  }
  entries.sort((a, b) => b.time - a.time || b.entry.name.localeCompare(a.entry.name))
  return entries.map((e) => e.entry)
}

/** Deletes every backup in `dir` past the newest `keep`; answers what it deleted. */
export function pruneBackups(dir: string, keep: number): BackupEntry[] {
  const doomed = backupsToPrune(listBackups(dir), keep)
  for (const entry of doomed) fs.rmSync(entry.file, { force: true })
  return doomed
}

/**
 * The entry's path segments, or null for any name that could land outside the target: absolute
 * or drive paths, backslashes, `.`/`..` or empty segments, NUL bytes.
 */
function safeSegments(name: string): string[] | null {
  if (name.length === 0 || name.includes('\\') || name.includes('\0')) return null
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const segments = name.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  return segments
}

/**
 * Unpacks a backup into `target`, which must not exist yet. Everything is checked before a byte
 * is written — names, total size, a `project.db` that is a SQLite file — and a failure part way
 * removes the half-made folder. VALIDATION for anything that is not a MythScribe backup.
 */
export function extractBackup(zipFile: string, target: string): void {
  if (fs.existsSync(target)) {
    throw new AppError('ALREADY_EXISTS', `${target} already exists`, { folder: target })
  }
  const buffer = fs.readFileSync(zipFile)
  const files = (() => {
    try {
      return readZipDirectory(buffer).filter((entry) => !entry.name.endsWith('/'))
    } catch (err) {
      throw notABackup(err)
    }
  })()
  let total = 0
  const planned = files.map((entry) => {
    const segments = safeSegments(entry.name)
    if (segments === null) throw notABackup(`unsafe entry name: ${entry.name}`)
    total += entry.size
    return { entry, segments }
  })
  if (total > BACKUP_MAX_UNPACKED_BYTES) throw notABackup('it unpacks to more than 2 GB')
  const db = planned.find((p) => p.entry.name === DB_FILE)
  if (db === undefined) throw notABackup(`no ${DB_FILE}`)

  const root = path.resolve(target)
  fs.mkdirSync(root, { recursive: true })
  try {
    for (const { entry, segments } of planned) {
      // A foreign zip's live database files or crash journal would only confuse the snapshot.
      const top = segments[0] ?? ''
      if (top !== DB_FILE && EXCLUDED_TOP.has(top)) continue
      const data = (() => {
        try {
          return readZipEntry(buffer, entry)
        } catch (err) {
          throw notABackup(err)
        }
      })()
      if (entry === db.entry && !data.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
        throw notABackup(`${DB_FILE} is not a database`)
      }
      const dest = path.resolve(root, ...segments)
      if (!dest.startsWith(`${root}${path.sep}`))
        throw notABackup(`unsafe entry name: ${entry.name}`)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, data)
    }
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true })
    throw err
  }
}

function notABackup(cause: unknown): AppError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new AppError('VALIDATION', NOT_A_BACKUP, { reason })
}
