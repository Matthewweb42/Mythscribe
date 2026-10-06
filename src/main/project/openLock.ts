import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AppError } from '../ipc/errors'

/**
 * The open marker (decided 2026-10-06): a small file in the project folder that says which
 * machine has the project open. SQLite's own locks do not travel through Google Drive, OneDrive,
 * or Dropbox, but this file does, so a second computer refuses to open a project that is open
 * elsewhere instead of writing over it. Kept fresh by a heartbeat; a marker older than
 * `OPEN_LOCK_STALE_MS` is from a crash or a machine that went to sleep and is taken over.
 */
export const OPEN_LOCK_FILE = '.mythscribe-open'
export const OPEN_LOCK_HEARTBEAT_MS = 60_000
export const OPEN_LOCK_STALE_MS = 5 * 60_000

const LockRecord = z.object({
  host: z.string(),
  pid: z.number().int(),
  token: z.string(),
  heartbeat: z.string()
})
type LockRecord = z.infer<typeof LockRecord>

export interface OpenLockDeps {
  host: string
  pid: number
  now: () => Date
  /** Whether a process with this id is running on this machine. */
  isAlive: (pid: number) => boolean
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const defaultDeps = (): OpenLockDeps => ({
  host: os.hostname(),
  pid: process.pid,
  now: () => new Date(),
  isAlive: processIsAlive
})

function readLock(file: string): LockRecord | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = LockRecord.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Who holds the marker, when it is someone other than this process and still fresh. */
export function foreignHolder(
  folder: string,
  deps: OpenLockDeps = defaultDeps()
): LockRecord | null {
  const lock = readLock(path.join(folder, OPEN_LOCK_FILE))
  if (!lock) return null
  if (lock.host === deps.host) {
    if (lock.pid === deps.pid || !deps.isAlive(lock.pid)) return null
    return lock
  }
  const age = deps.now().getTime() - Date.parse(lock.heartbeat)
  return Number.isFinite(age) && age < OPEN_LOCK_STALE_MS ? lock : null
}

export class OpenLock {
  private timer: NodeJS.Timeout | null = null
  private readonly file: string

  private constructor(
    folder: string,
    private readonly token: string,
    private readonly deps: OpenLockDeps
  ) {
    this.file = path.join(folder, OPEN_LOCK_FILE)
  }

  /**
   * Takes the marker, or throws IO naming the machine that has the project open. A folder the
   * marker cannot be written to (read-only media) opens without one.
   */
  static acquire(folder: string, deps: OpenLockDeps = defaultDeps()): OpenLock {
    const holder = foreignHolder(folder, deps)
    if (holder) {
      const where = holder.host === deps.host ? 'in another MythScribe window' : `on ${holder.host}`
      throw new AppError(
        'IO',
        `This project is open ${where}. Close it there first, let your sync app catch up, then open it here.`,
        { folder, host: holder.host }
      )
    }
    const lock = new OpenLock(folder, `${deps.host}:${deps.pid}:${Date.now()}`, deps)
    lock.write()
    lock.timer = setInterval(() => lock.write(), OPEN_LOCK_HEARTBEAT_MS)
    lock.timer.unref()
    return lock
  }

  private write(): void {
    const record: LockRecord = {
      host: this.deps.host,
      pid: this.deps.pid,
      token: this.token,
      heartbeat: this.deps.now().toISOString()
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(record))
    } catch (err) {
      console.warn('Could not write the project open marker', err)
    }
  }

  /** Stops the heartbeat and removes the marker, unless another holder has replaced it. */
  release(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (readLock(this.file)?.token !== this.token) return
    try {
      fs.rmSync(this.file, { force: true })
    } catch (err) {
      console.warn('Could not remove the project open marker', err)
    }
  }
}
