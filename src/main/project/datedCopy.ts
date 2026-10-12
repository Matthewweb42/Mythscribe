import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../ipc/errors'
import { OPEN_LOCK_FILE } from './openLock'
import { RECOVERY_DIR } from './recoveryJournal'

/** The project's database file (the same name as `DB_FILE`, kept here so nothing imports back). */
const DB = 'project.db'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** The stamp a dated copy carries: `YYYY-MM-DD HHmm` on this computer's clock. */
export function datedCopyStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Where a dated copy of `folder` goes: beside it as `<Name> (<label> YYYY-MM-DD HHmm)<ext>`, with
 * ` 2`, ` 3` … when that is taken.
 */
export function datedCopyPath(folder: string, now: Date, label: string): string {
  const ext = path.extname(folder)
  const base = path.basename(folder, ext)
  const parent = path.dirname(folder)
  const stem = `${base} (${label} ${datedCopyStamp(now)})`
  let target = path.join(parent, `${stem}${ext}`)
  for (let n = 2; fs.existsSync(target); n++) target = path.join(parent, `${stem} ${n}${ext}`)
  return target
}

export interface DatedCopyOptions {
  /**
   * A self-contained database file (no `-wal`) that stands in for the folder's own: a snapshot of
   * an open project, or the working copy's version with the folder's assets.
   */
  database?: string
  /** The start of the error the author sees when the copy fails ("Could not keep …"). */
  failure?: string
}

/**
 * Copies a project folder beside itself under a dated name (`datedCopyPath`): a whole project the
 * author can open, minus the open marker, the crash journal, SQLite's `-shm` and temp files. One
 * helper for every such copy: the cloud conflict copy (`conflict`, 2026-10-10) and the story-memory
 * switch-over's safety copy and trial copy (F-16.15, `before story memory`, `story memory test`).
 * Throws IO when it cannot, and then removes what it had copied, so nothing is left half made.
 */
export function saveDatedCopy(
  folder: string,
  now: Date,
  label: string,
  options: DatedCopyOptions = {}
): string {
  const target = datedCopyPath(folder, now, label)
  const root = path.resolve(folder)
  const { database } = options
  try {
    fs.cpSync(folder, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (src) => {
        const rel = path.relative(root, path.resolve(src))
        if (rel === '') return true
        const top = rel.split(path.sep)[0]
        const name = path.basename(src)
        if (database !== undefined && top === name && (name === DB || name === `${DB}-wal`)) {
          return false
        }
        return (
          top !== OPEN_LOCK_FILE &&
          top !== RECOVERY_DIR &&
          name !== `${DB}-shm` &&
          !name.endsWith('.tmp')
        )
      }
    })
    if (database !== undefined) fs.copyFileSync(database, path.join(target, DB))
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true })
    throw new AppError(
      'IO',
      `${options.failure ?? 'Could not save a copy of this project beside it'}: ${(err as Error).message}`,
      { folder }
    )
  }
  return target
}
