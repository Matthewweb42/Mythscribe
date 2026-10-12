import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import {
  SAFETY_COPY_LABEL,
  SWITCHOVER_TRIAL_KEY,
  SwitchoverTrial,
  TRIAL_COPY_LABEL
} from '@shared/memory/switchover'
import { settings } from '../../db/schema'
import { rollbackSnapshot } from '../../db/snapshot'
import { AppError } from '../../ipc/errors'
import { datedCopyStamp, saveDatedCopy } from '../../project/datedCopy'
import type { TreeDb } from '../../tree/treeStore'

/**
 * Copies only in P1 (F-16.15, decision P1-D12): the switch-over runs on a duplicate made by
 * Help › Try the story-memory switch-over on a copy…, which unpackaged builds show. The duplicate
 * carries the `switchoverTrial` row and a project id and name of its own (its backups never mix
 * with the original's); the `switchover:*` channels refuse any project without the row unless the
 * in-place run of F-16.31 passes `allowInPlace`.
 */

/** The project's trial marker, or null for a real project (or an unreadable row). */
export function switchoverTrialOf(db: TreeDb): SwitchoverTrial | null {
  const row = db.select().from(settings).where(eq(settings.key, SWITCHOVER_TRIAL_KEY)).get()
  if (row === undefined) return null
  try {
    const parsed = SwitchoverTrial.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const NOT_A_TRIAL =
  'The story-memory switch-over runs only on a test copy in this build: use Help › Try the story-memory switch-over on a copy….'

/** VALIDATION unless the project is a trial copy or the caller is the in-place run (F-16.31). */
export function requireSwitchoverTarget(db: TreeDb, options: { allowInPlace: boolean }): void {
  if (options.allowInPlace) return
  if (switchoverTrialOf(db) === null) throw new AppError('VALIDATION', NOT_A_TRIAL)
}

/** What a trial copy is made from: the open project's folder, its connection, and its name. */
export interface TrialSource {
  folder: string
  sqlite: Database.Database
  name: string
}

/**
 * A dated copy of the open project beside it (`saveDatedCopy`) whose database is a snapshot of
 * `sqlite` as it reads now, so the project's own files are only read. Answers the copy's folder.
 */
function snapshotCopy(
  source: Pick<TrialSource, 'folder' | 'sqlite'>,
  now: Date,
  label: string,
  failure: string
): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-copy-'))
  try {
    const snapshot = path.join(scratch, 'project.db')
    fs.writeFileSync(snapshot, rollbackSnapshot(source.sqlite))
    return saveDatedCopy(source.folder, now, label, { database: snapshot, failure })
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Step 1's dated copy (F-16.15, decision P1-D13): `<Folder> (before story memory YYYY-MM-DD
 * HHmm)` beside the project, wherever it lives, made just before the conversion writes.
 */
export function saveSafetyCopy(source: Pick<TrialSource, 'folder' | 'sqlite'>, now: Date): string {
  return snapshotCopy(
    source,
    now,
    SAFETY_COPY_LABEL,
    'Could not keep a copy of this project before the switch-over'
  )
}

/**
 * Makes the trial copy beside the project (`<Folder> (story memory test YYYY-MM-DD HHmm)`): the
 * project's database as its connection sees it now (a snapshot, so the original's files are only
 * read), with the folder's assets; then, in the copy only, a new project id, the name
 * `<Name> (story memory test …)` and the `switchoverTrial` row. Answers the copy's folder; on a
 * failure nothing is left behind.
 */
export function createTrialCopy(source: TrialSource, now: Date): string {
  const copy = snapshotCopy(
    source,
    now,
    TRIAL_COPY_LABEL,
    'Could not make the test copy of this project'
  )
  try {
    const db = new Database(path.join(copy, 'project.db'))
    try {
      const marker: SwitchoverTrial = { source: source.folder, createdAt: now.toISOString() }
      db.transaction(() => {
        db.prepare('UPDATE project SET id = ?, name = ?').run(
          randomUUID(),
          `${source.name} (${TRIAL_COPY_LABEL} ${datedCopyStamp(now)})`
        )
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run(SWITCHOVER_TRIAL_KEY, JSON.stringify(marker))
      })()
    } finally {
      db.close()
    }
  } catch (err) {
    fs.rmSync(copy, { recursive: true, force: true })
    throw new AppError('IO', `Could not mark the test copy: ${(err as Error).message}`, {
      folder: copy
    })
  }
  return copy
}
