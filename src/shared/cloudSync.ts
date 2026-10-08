import { z } from 'zod'

/**
 * Projects in a cloud-synced folder (author request 2026-10-08; details decided by Claude,
 * unconfirmed): SQLite cannot run reliably on Google Drive for desktop's virtual drive (reads
 * fail with "disk I/O error" while Drive streams the file), so a project found in a synced folder
 * is worked on through a private copy of its database on this computer, and that copy is written
 * back into the project folder every few minutes, when the project closes, and before the app
 * quits. Plain folders open in place exactly as before.
 */

export const CLOUD_PROVIDERS = ['googleDrive', 'oneDrive', 'dropbox', 'iCloud'] as const
export const CloudProvider = z.enum(CLOUD_PROVIDERS)
export type CloudProvider = z.infer<typeof CloudProvider>

export const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = {
  googleDrive: 'Google Drive',
  oneDrive: 'OneDrive',
  dropbox: 'Dropbox',
  iCloud: 'iCloud Drive'
}

/** How often a changed project is copied back while it is open. */
export const CLOUD_SYNC_INTERVAL_MS = 3 * 60_000
/** The first retry after a failed copy; each further failure doubles it, up to the interval. */
export const CLOUD_SYNC_RETRY_MS = 30_000

/**
 * `synced`: the last copy reached the cloud folder (newer changes wait for the next one).
 * `copying`: a copy is running. `failed`: the last copy failed; it is retried by itself.
 */
export const CloudSyncState = z.enum(['synced', 'copying', 'failed'])
export type CloudSyncState = z.infer<typeof CloudSyncState>

/** What the status bar shows for a project in a synced folder; null for any other project. */
export const CloudSyncStatus = z.object({
  provider: CloudProvider,
  state: CloudSyncState,
  /** ISO time of the last copy that reached the cloud folder in this session or before. */
  lastSyncedAt: z.string().nullable(),
  /** Why the last copy failed, while `state` is `failed`. */
  error: z.string().nullable(),
  /**
   * A copy of the cloud version saved beside the project this session, because it had changed
   * elsewhere while this computer also had changes. Both are kept; the author decides.
   */
  conflictCopy: z.string().nullable()
})
export type CloudSyncStatus = z.infer<typeof CloudSyncStatus>

/** The status line: "Copied to Google Drive 2 min ago", "Copying to Google Drive…", and so on. */
export function describeCloudSync(status: CloudSyncStatus, now: Date = new Date()): string {
  const label = CLOUD_PROVIDER_LABEL[status.provider]
  switch (status.state) {
    case 'copying':
      return `Copying to ${label}…`
    case 'failed':
      return `Could not copy to ${label}. Retrying`
    case 'synced':
      return status.lastSyncedAt === null
        ? `Working on a local copy for ${label}`
        : `Copied to ${label} ${agoText(status.lastSyncedAt, now)}`
  }
}

function agoText(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`
}

/** The status line's tooltip: what the arrangement is, in one breath. */
export function cloudSyncExplainer(status: CloudSyncStatus): string {
  const label = CLOUD_PROVIDER_LABEL[status.provider]
  const base = `This project is in ${label}. MythScribe works on a copy on this computer and copies it to ${label} every few minutes, when you close the project, and when you quit.`
  return status.state === 'failed' && status.error !== null ? `${base}\n\n${status.error}` : base
}
