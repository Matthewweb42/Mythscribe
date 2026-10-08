import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { CloudProvider } from '@shared/cloudSync'
import { CLOUD_PROVIDER_LABEL } from '@shared/cloudSync'
import { AppError } from '../ipc/errors'
import { OPEN_LOCK_FILE } from './openLock'
import { RECOVERY_DIR } from './recoveryJournal'

/**
 * The local working copy of a project kept in a cloud-synced folder (2026-10-08, the author's
 * choice; the details are decided by Claude, unconfirmed). SQLite opens `<root>/<id>/project.db`
 * on this computer, never the database in Google Drive, OneDrive, Dropbox, or iCloud; the project
 * folder keeps its assets, the open marker, and the database the sync app uploads, which this
 * class writes whole (a serialized snapshot to a temp file beside it, then a rename) every few
 * minutes, when the project closes, and when the app quits.
 *
 * Nothing newer is ever overwritten. `working.json` remembers what the cloud folder held when
 * the two last agreed (size and mtime of the database and its `-wal`, and a hash of the bytes);
 * while a session is open it says `dirty`, so a crash leaves the working copy marked as possibly
 * ahead of the cloud. Opening then decides:
 * - no working copy yet, or a clean one and the cloud changed: copy the cloud version in;
 * - clean and unchanged: open the working copy as it is;
 * - dirty and the cloud unchanged: open the working copy and copy it back at once;
 * - dirty and the cloud changed too: keep both. The cloud version is saved beside the project
 *   as `<Name> (conflict YYYY-MM-DD HHmm).mythscribe`, the working copy opens, and the author is
 *   told. A copy back that finds the cloud changed under it does the same before it writes.
 */

export const WORKING_STATE_FILE = 'working.json'
/** Same name as the project's own database, so a working folder reads like a project folder. */
const DB = 'project.db'
const SIDE_FILES = ['-wal', '-shm'] as const
/** Temp files this class writes into the cloud folder; anything left by a crash is removed. */
const SYNC_TMP = /^project\.db\.sync-[0-9a-f-]+\.tmp$/

const Fingerprint = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  walSize: z.number().nullable(),
  walMtimeMs: z.number().nullable()
})
type Fingerprint = z.infer<typeof Fingerprint>

const WorkingState = z.object({
  version: z.literal(1),
  cloudFolder: z.string(),
  /** The cloud database as it was when the two copies last agreed; null before it existed. */
  cloud: Fingerprint.nullable(),
  /** sha256 of the cloud database bytes then its `-wal` bytes at that moment. */
  cloudHash: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  /** The working copy may hold changes the cloud folder lacks (a session open, a failed copy). */
  dirty: z.boolean()
})
type WorkingState = z.infer<typeof WorkingState>

export interface WorkingCopyDeps {
  now: () => Date
}

const defaultDeps: WorkingCopyDeps = { now: () => new Date() }

/** One folder per cloud project, named by its path, so two projects never share a copy. */
export function workingDirFor(root: string, cloudFolder: string): string {
  const resolved = path.resolve(cloudFolder)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return path.join(root, createHash('sha256').update(key).digest('hex').slice(0, 32))
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function fingerprintOf(folder: string): Fingerprint | null {
  const db = statOrNull(path.join(folder, DB))
  if (db === null) return null
  const wal = statOrNull(path.join(folder, `${DB}-wal`))
  return {
    size: db.size,
    mtimeMs: db.mtimeMs,
    walSize: wal?.size ?? null,
    walMtimeMs: wal?.mtimeMs ?? null
  }
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.walSize === b.walSize &&
    a.walMtimeMs === b.walMtimeMs
  )
}

function hashOf(folder: string): string {
  const hash = createHash('sha256').update(fs.readFileSync(path.join(folder, DB)))
  const wal = path.join(folder, `${DB}-wal`)
  if (fs.existsSync(wal)) hash.update(fs.readFileSync(wal))
  return hash.digest('hex')
}

function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function readState(dir: string, cloudFolder: string): WorkingState | null {
  try {
    const parsed = WorkingState.safeParse(
      JSON.parse(fs.readFileSync(path.join(dir, WORKING_STATE_FILE), 'utf8'))
    )
    if (!parsed.success) return null
    return path.resolve(parsed.data.cloudFolder) === path.resolve(cloudFolder) ? parsed.data : null
  } catch {
    return null
  }
}

/** Atomic on the local disk: a temp sibling, flushed, then renamed. */
function writeState(dir: string, state: WorkingState): void {
  const file = path.join(dir, WORKING_STATE_FILE)
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Copies the cloud folder's current project beside it as `<Name> (conflict YYYY-MM-DD HHmm)`
 * (` 2`, ` 3` on collision): a whole project the author can open, minus the open marker, the
 * crash journal, and temp files. Throws when it cannot, and then nothing gets overwritten.
 */
export function saveConflictCopy(cloudFolder: string, now: Date): string {
  const ext = path.extname(cloudFolder)
  const base = path.basename(cloudFolder, ext)
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
  const parent = path.dirname(cloudFolder)
  let target = path.join(parent, `${base} (conflict ${stamp})${ext}`)
  for (let n = 2; fs.existsSync(target); n++) {
    target = path.join(parent, `${base} (conflict ${stamp}) ${n}${ext}`)
  }
  const root = path.resolve(cloudFolder)
  try {
    fs.cpSync(cloudFolder, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (src) => {
        const rel = path.relative(root, path.resolve(src))
        if (rel === '') return true
        const top = rel.split(path.sep)[0]
        const name = path.basename(src)
        return (
          top !== OPEN_LOCK_FILE &&
          top !== RECOVERY_DIR &&
          name !== `${DB}-shm` &&
          !name.endsWith('.tmp')
        )
      }
    })
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true })
    throw new AppError(
      'IO',
      `Could not keep the other version of this project beside it: ${(err as Error).message}`,
      { folder: cloudFolder }
    )
  }
  return target
}

/**
 * Makes `dest` a self-contained copy of the cloud database: the database and its `-wal` (an
 * older MythScribe that crashed on the drive leaves one) are copied to temp names here, the WAL
 * is checkpointed into the database by SQLite on this local disk, and only then does the result
 * replace `dest`. Any old `-wal`/`-shm` of `dest` goes first: one from another database would
 * corrupt the new one.
 */
function copyIn(cloudFolder: string, dir: string, dest: string): void {
  const incoming = path.join(dir, `incoming-${randomUUID()}.db`)
  try {
    fs.copyFileSync(path.join(cloudFolder, DB), incoming)
    const cloudWal = path.join(cloudFolder, `${DB}-wal`)
    if (fs.existsSync(cloudWal)) {
      fs.copyFileSync(cloudWal, `${incoming}-wal`)
      const db = new Database(incoming)
      try {
        db.pragma('wal_checkpoint(TRUNCATE)')
        db.pragma('journal_mode = DELETE')
      } finally {
        db.close()
      }
    }
    for (const side of SIDE_FILES) fs.rmSync(`${dest}${side}`, { force: true })
    fs.renameSync(incoming, dest)
  } finally {
    for (const suffix of ['', ...SIDE_FILES]) fs.rmSync(`${incoming}${suffix}`, { force: true })
  }
}

function syncError(provider: CloudProvider, err: unknown): AppError {
  if (err instanceof AppError) return err
  const cause = err instanceof Error ? err.message : String(err)
  return new AppError(
    'IO',
    `Could not copy the project to ${CLOUD_PROVIDER_LABEL[provider]}: ${cause}`
  )
}

export class WorkingCopy {
  /** The database SQLite opens: the working copy on this computer. */
  readonly dbFile: string
  /** A conflict copy saved this session (on open or on a copy back), for the author to see. */
  conflictCopy: string | null = null
  /** The working copy holds changes from before this session that the cloud folder lacks. */
  private carried: boolean
  /** `total_changes()` on the session's connection at the last copy back; 0 = since it opened. */
  private baseline = 0
  /** Bumped by every copy back, so a slow one never lands over a newer one. */
  private generation = 0
  private finished = false

  private constructor(
    readonly provider: CloudProvider,
    readonly cloudFolder: string,
    readonly dir: string,
    private state: WorkingState,
    private readonly deps: WorkingCopyDeps,
    carried: boolean
  ) {
    this.dbFile = path.join(dir, DB)
    this.carried = carried
  }

  /** Prepares the working copy of an existing cloud project (see the class comment). */
  static open(
    cloudFolder: string,
    root: string,
    provider: CloudProvider,
    deps: WorkingCopyDeps = defaultDeps
  ): WorkingCopy {
    const dir = workingDirFor(root, cloudFolder)
    fs.mkdirSync(dir, { recursive: true })
    removeSyncLeftovers(cloudFolder)
    const dbFile = path.join(dir, DB)
    let state = readState(dir, cloudFolder)
    let carried = false
    let conflict: string | null = null
    const now = deps.now()

    const takeCloud = (lastSyncedAt: string | null): WorkingState => {
      const cloud = fingerprintOf(cloudFolder)
      if (cloud === null) {
        throw new AppError('NOT_FOUND', `${cloudFolder} has no ${DB}`, { path: cloudFolder })
      }
      const cloudHash = hashOf(cloudFolder)
      copyIn(cloudFolder, dir, dbFile)
      return { version: 1, cloudFolder, cloud, cloudHash, lastSyncedAt, dirty: false }
    }

    if (!fs.existsSync(dbFile)) {
      state = takeCloud(state?.lastSyncedAt ?? now.toISOString())
    } else if (state === null) {
      // A working copy without its record: whether it is ahead is unknown, so keep both.
      conflict = saveConflictCopy(cloudFolder, now)
      state = {
        version: 1,
        cloudFolder,
        cloud: fingerprintOf(cloudFolder),
        cloudHash: hashOf(cloudFolder),
        lastSyncedAt: null,
        dirty: true
      }
      carried = true
    } else {
      const unchanged = cloudMatches(cloudFolder, state)
      if (!state.dirty && !unchanged) {
        state = takeCloud(now.toISOString())
      } else if (state.dirty && !unchanged) {
        conflict = saveConflictCopy(cloudFolder, now)
        // The copy back may now replace what was kept, without keeping it a second time.
        state = { ...state, cloud: fingerprintOf(cloudFolder), cloudHash: hashOf(cloudFolder) }
        carried = true
      } else if (state.dirty) {
        carried = true
      }
    }
    moveRecoveryJournal(cloudFolder, dir)
    // Until a clean close says otherwise, a crash must leave this copy marked as possibly ahead.
    state = { ...state, dirty: true }
    writeState(dir, state)
    const copy = new WorkingCopy(provider, cloudFolder, dir, state, deps, carried)
    copy.conflictCopy = conflict
    return copy
  }

  /**
   * Prepares the working copy of a project about to be created in `cloudFolder`. A copy left
   * at that path by an earlier project is moved aside, never deleted.
   */
  static create(
    cloudFolder: string,
    root: string,
    provider: CloudProvider,
    deps: WorkingCopyDeps = defaultDeps
  ): WorkingCopy {
    const dir = workingDirFor(root, cloudFolder)
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      fs.renameSync(dir, `${dir}.orphaned-${deps.now().getTime()}`)
    }
    fs.mkdirSync(dir, { recursive: true })
    const state: WorkingState = {
      version: 1,
      cloudFolder,
      cloud: null,
      cloudHash: null,
      lastSyncedAt: null,
      dirty: true
    }
    writeState(dir, state)
    return new WorkingCopy(provider, cloudFolder, dir, state, deps, true)
  }

  /** Recovery journal and other per-computer files live here rather than in the cloud folder. */
  get localFolder(): string {
    return this.dir
  }

  /** Whether this copy opened with changes the cloud folder lacks (a crash, a failed copy). */
  get carriesChanges(): boolean {
    return this.carried
  }

  get lastSyncedAt(): string | null {
    return this.state.lastSyncedAt
  }

  /** Whether a copy back has something to do: changes since the last one, or carried ones. */
  hasChanges(sqlite: Database.Database): boolean {
    return this.carried || totalChanges(sqlite) !== this.baseline
  }

  /** Copies the working copy back now, blocking: for closing and creating. Throws with the cause. */
  syncNow(sqlite: Database.Database): void {
    const data = snapshotOf(sqlite)
    const changes = totalChanges(sqlite)
    this.generation++
    const tmp = this.tmpFile()
    try {
      fs.writeFileSync(tmp, data)
      this.commit(tmp, data, changes)
    } catch (err) {
      throw syncError(this.provider, err)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  /**
   * Copies the working copy back without blocking main while the cloud drive is slow: the
   * snapshot is taken at once, the bytes are written to a temp file asynchronously, and the
   * rename runs only if no newer copy started and the session is still open. Answers false
   * when it was superseded. Throws with the cause.
   */
  async sync(sqlite: Database.Database): Promise<boolean> {
    const data = snapshotOf(sqlite)
    const changes = totalChanges(sqlite)
    const mine = ++this.generation
    const tmp = this.tmpFile()
    try {
      await fs.promises.writeFile(tmp, data)
      if (mine !== this.generation || this.finished) return false
      this.commit(tmp, data, changes)
      return true
    } catch (err) {
      throw syncError(this.provider, err)
    } finally {
      await fs.promises.rm(tmp, { force: true })
    }
  }

  /**
   * The session closed. `clean` = its last copy back succeeded (or it had nothing to copy), so
   * the working copy and the cloud folder agree and the next open need not treat it as ahead.
   */
  finish(clean: boolean): void {
    this.finished = true
    if (!clean) return
    this.state = { ...this.state, dirty: false }
    try {
      writeState(this.dir, this.state)
    } catch (err) {
      console.warn('Could not record the working copy as copied back', err)
    }
  }

  /**
   * The open failed after the working copy was prepared (a migration, a missing record): put
   * back the flag it had, so a copy that was clean is not treated as ahead next time.
   */
  abandon(): void {
    this.finished = true
    this.state = { ...this.state, dirty: this.carried }
    try {
      writeState(this.dir, this.state)
    } catch (err) {
      console.warn('Could not record the working copy state', err)
    }
  }

  /** The create it was prepared for failed: nothing in it was ever the author's. */
  discard(): void {
    this.finished = true
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  private tmpFile(): string {
    return path.join(this.cloudFolder, `${DB}.sync-${randomUUID()}.tmp`)
  }

  /** Synchronous from here to the rename, so no other copy back can interleave. */
  private commit(tmp: string, data: Buffer, changes: number): void {
    if (!fs.existsSync(this.cloudFolder)) {
      throw new AppError('IO', `The project folder is gone from ${this.cloudFolder}.`)
    }
    const cloudDb = path.join(this.cloudFolder, DB)
    if (!cloudMatches(this.cloudFolder, this.state)) {
      this.conflictCopy = saveConflictCopy(this.cloudFolder, this.deps.now())
    }
    const sides = SIDE_FILES.map((side) => `${cloudDb}${side}`).filter((f) => fs.existsSync(f))
    if (sides.length > 0) {
      // A `-wal` beside the new database would be replayed into it; its frames are already in
      // the working copy (or in the conflict copy just made). Record the database alone first,
      // so a failed rename below is not mistaken for a change made elsewhere.
      for (const side of sides) fs.rmSync(side, { force: true })
      this.state = {
        ...this.state,
        cloud: fingerprintOf(this.cloudFolder),
        cloudHash: fs.existsSync(cloudDb) ? hashOf(this.cloudFolder) : null
      }
      writeState(this.dir, this.state)
    }
    fs.renameSync(tmp, cloudDb)
    this.state = {
      ...this.state,
      cloud: fingerprintOf(this.cloudFolder),
      cloudHash: hashBytes(data),
      lastSyncedAt: this.deps.now().toISOString()
    }
    writeState(this.dir, this.state)
    this.baseline = changes
    this.carried = false
  }
}

/** Whether the cloud folder still holds what `state` recorded (a missing database counts as yes). */
function cloudMatches(cloudFolder: string, state: WorkingState): boolean {
  const current = fingerprintOf(cloudFolder)
  if (current === null) return true
  if (state.cloud === null || state.cloudHash === null) return false
  if (sameFingerprint(current, state.cloud)) return true
  // Sync apps touch modification times; only different bytes are a change.
  return hashOf(cloudFolder) === state.cloudHash
}

/**
 * The whole database as SQLite sees it (WAL included), as a rollback-journal file: header bytes
 * 18 and 19 say 1 instead of 2, which is what `journal_mode = DELETE` writes. The copy in the
 * cloud folder then needs no `-wal` or `-shm` to be read; MythScribe switches it back to WAL
 * wherever it is opened for writing.
 */
function snapshotOf(sqlite: Database.Database): Buffer {
  const data = sqlite.serialize()
  if (data.length >= 100) {
    data[18] = 1
    data[19] = 1
  }
  return data
}

function totalChanges(sqlite: Database.Database): number {
  return sqlite.prepare<[], { n: number }>('SELECT total_changes() AS n').get()?.n ?? 0
}

function removeSyncLeftovers(cloudFolder: string): void {
  try {
    for (const name of fs.readdirSync(cloudFolder)) {
      if (SYNC_TMP.test(name)) fs.rmSync(path.join(cloudFolder, name), { force: true })
    }
  } catch (err) {
    console.warn('Could not tidy the project folder', err)
  }
}

/**
 * The crash journal (F-8.3) is written every quarter second while the author types; in a cloud
 * folder it lives with the working copy. One left in the project folder by an older version is
 * moved over once, and removed from the cloud folder only after the copy succeeded.
 */
function moveRecoveryJournal(cloudFolder: string, dir: string): void {
  const from = path.join(cloudFolder, RECOVERY_DIR)
  const to = path.join(dir, RECOVERY_DIR)
  if (!fs.existsSync(from) || fs.existsSync(to)) return
  try {
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  } catch (err) {
    console.warn('Could not move the crash journal next to the working copy', err)
  }
}
