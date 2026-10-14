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
 * Test copies and the safety copy (F-16.15, decision P1-D12; F-16.31). A test copy (*Try it on a
 * copy first*) is a duplicate beside the project that carries the `switchoverTrial` row and a
 * project id and name of its own (its backups never mix with the original's); the switch-over runs
 * on it as on the project itself, minus the safety step (`run.ts`, decision SW-D4). The safety
 * copy is the dated copy the real run makes before its dry run.
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
 * The safety step's dated copy (F-16.15, decision P1-D13; F-16.31): `<Folder> (before story
 * memory YYYY-MM-DD HHmm)` beside the project, wherever it lives (in Google Drive for a Drive
 * project), made before the dry run.
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
