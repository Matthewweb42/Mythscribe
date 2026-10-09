import { z } from 'zod'

/**
 * Automatic backups (F-8.4): what the app remembers about them (app-wide, in app-state.json),
 * what the Backups tab shows, and the names the files get. Main writes, lists, prunes, and
 * restores the zips; the renderer only displays the state main reports and forwards choices.
 *
 * A backup is `<folder>/<project> (<id8>)/<project> YYYY-MM-DD HHmmss.zip` in local time. Only
 * files that match that name are ever listed or pruned, so nothing else in the folder is touched.
 */

/** How often a changed project is backed up while it is open, in minutes. */
export const BACKUP_INTERVALS = [15, 30, 60, 120] as const
export const BackupInterval = z.literal(BACKUP_INTERVALS)
export type BackupInterval = z.infer<typeof BackupInterval>

/** How many backups are kept per project; older ones are deleted after each new backup. */
export const BACKUP_KEEP_CHOICES = [5, 10, 20, 50] as const
export const BackupKeep = z.literal(BACKUP_KEEP_CHOICES)
export type BackupKeep = z.infer<typeof BackupKeep>

/** Stored in app-state.json under `backups`; every field defaulted so older files load. */
export const BackupSettings = z.object({
  /** Whether the app backs up by itself (on the schedule and on close); "Back up now" always works. */
  enabled: z.boolean().default(true),
  /** The chosen folder, or null for the default one main works out for this machine. */
  folder: z.string().min(1).nullable().default(null),
  intervalMinutes: BackupInterval.default(30),
  /** Also back up when the project closes (the app quits, another project opens). */
  onClose: z.boolean().default(true),
  keep: BackupKeep.default(10)
})
export type BackupSettings = z.infer<typeof BackupSettings>

export function defaultBackupSettings(): BackupSettings {
  return { enabled: true, folder: null, intervalMinutes: 30, onClose: true, keep: 10 }
}

/**
 * A change from the Backups tab. `folder` can only be reset to the default here: a new folder
 * comes from main's own folder dialog (`backups:chooseFolder`), never a path the renderer sends.
 */
export const BackupSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  folder: z.null().optional(),
  intervalMinutes: BackupInterval.optional(),
  onClose: z.boolean().optional(),
  keep: BackupKeep.optional()
})
export type BackupSettingsPatch = z.infer<typeof BackupSettingsPatch>

/** One backup of the open project. */
export const BackupEntry = z.object({
  /** Absolute path of the zip. */
  file: z.string(),
  /** The file name, as the folder shows it. */
  name: z.string(),
  /** When it was made (from the file name, local time), as ISO. */
  createdAt: z.string(),
  bytes: z.number().int().nonnegative()
})
export type BackupEntry = z.infer<typeof BackupEntry>

/** Everything the Backups tab reads; main answers it whole. */
export const BackupState = z.object({
  settings: BackupSettings,
  /** The folder backups go to now: the chosen one, or the default. */
  folder: z.string(),
  defaultFolder: z.string(),
  /** The open project's backups, newest first; empty with no project open. */
  backups: z.array(BackupEntry),
  /** The newest backup of the open project, or null. */
  lastBackupAt: z.string().nullable(),
  /** Why the last automatic backup failed, until the next one succeeds. */
  lastError: z.string().nullable()
})
export type BackupState = z.infer<typeof BackupState>

/** Larger than any real project; a zip that unpacks to more is refused before anything is written. */
export const BACKUP_MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `YYYY-MM-DD HHmmss` in local time: the date part of every backup file name. */
export function backupStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** `<name> YYYY-MM-DD HHmmss.zip` in local time; `safeName` is already a valid file name. */
export function backupFileName(safeName: string, date: Date): string {
  return `${safeName} ${backupStamp(date)}.zip`
}

const BACKUP_NAME = /^.+ (\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})\.zip$/

/** When a backup file was made, or null for any file that is not one of ours. */
export function parseBackupFileName(name: string): Date | null {
  const match = BACKUP_NAME.exec(name)
  if (match === null) return null
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number)
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined
  ) {
    return null
  }
  const date = new Date(year, month - 1, day, hours, minutes, seconds)
  // Rejects 2026-02-31 and 25:00, which `Date` would quietly roll over.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes ||
    date.getSeconds() !== seconds
  ) {
    return null
  }
  return date
}

/**
 * The project name a backup file carries (what comes before the date), or the file name without
 * `.zip` for a zip named some other way; names the restored copy.
 */
export function backupProjectName(fileName: string): string {
  const match = /^(.+) \d{4}-\d{2}-\d{2} \d{6}\.zip$/i.exec(fileName)
  if (match?.[1] !== undefined) return match[1]
  return fileName.replace(/\.zip$/i, '')
}

/** The id part of a project's backup folder name: two projects with one name never mix. */
export function projectBackupDirSuffix(projectId: string): string {
  return `(${projectId.slice(0, 8)})`
}

/** `<name> (<first 8 of the id>)`; `safeName` is already a valid file name. */
export function projectBackupDirName(safeName: string, projectId: string): string {
  return `${safeName} ${projectBackupDirSuffix(projectId)}`
}

/** `<name> (restored YYYY-MM-DD HHmm).mythscribe`; `safeName` is already a valid file name. */
export function restoredFolderName(safeName: string, date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${safeName} (restored ${day} ${pad(date.getHours())}${pad(date.getMinutes())}).mythscribe`
}

/** The backups past the newest `keep`, given newest first: the ones retention deletes. */
export function backupsToPrune<T>(entries: readonly T[], keep: number): T[] {
  return entries.slice(Math.max(0, keep))
}
