import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { backupStamp } from '@shared/backups'
import { AppError } from '../ipc/errors'
import type { MigrationStep } from './migrate'
import { rollbackSnapshot } from './snapshot'

/**
 * Migration safety (F-8.7): before a schema upgrade touches a project that already has one, the
 * database as it stands is written to `pre-migration-<from>-<to>-<YYYY-MM-DD HHmmss>.db` in the
 * project's backups folder. It is a plain SQLite file (rollback journal, no `-wal` needed), so a
 * copy can be opened by the build that wrote it. Only the newest `PRE_MIGRATION_KEEP` are kept;
 * the zip backups of F-8.4 never count or prune these. The snapshot is `serialize()` of the open
 * connection, so for a project in a cloud folder it is taken from the local working copy and the
 * cloud file is never read mid-write.
 */

export const PRE_MIGRATION_KEEP = 3

const NAME = /^pre-migration-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2} \d{6})\.db$/

export function preMigrationBackupName(step: MigrationStep, date: Date): string {
  return `pre-migration-${step.from}-${step.to}-${backupStamp(date)}.db`
}

/** The pre-migration backups in `dir`, newest first; other files are not ours. */
export function listPreMigrationBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const found: { name: string; stamp: string }[] = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile()) continue
    const match = NAME.exec(item.name)
    if (match?.[3] === undefined) continue
    found.push({ name: item.name, stamp: match[3] })
  }
  found.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.name.localeCompare(a.name))
  return found.map((f) => path.join(dir, f.name))
}

/**
 * Writes the snapshot (a `.tmp` sibling, then a rename) and prunes to the newest `keep`. A
 * failure throws IO with the folder, so the upgrade stops and the project stays as it was.
 */
export function writePreMigrationBackup(
  sqlite: Database.Database,
  dir: string,
  step: MigrationStep,
  now: Date = new Date(),
  keep: number = PRE_MIGRATION_KEEP
): string {
  const file = path.join(dir, preMigrationBackupName(step, now))
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, rollbackSnapshot(sqlite))
    fs.renameSync(tmp, file)
  } catch (err) {
    removeQuietly(tmp)
    throw new AppError(
      'IO',
      `Could not back up the project before updating it, so it was not changed. Check that ${dir} can be written to, or choose another backup folder in Settings › Backups.`,
      { folder: dir, cause: err instanceof Error ? err.message : String(err) }
    )
  }
  for (const old of listPreMigrationBackups(dir).slice(Math.max(0, keep))) {
    fs.rmSync(old, { force: true })
  }
  return file
}

/** Cleanup after a failed write: a path under a file, not a folder, cannot be removed either. */
function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // Nothing was written there.
  }
}
