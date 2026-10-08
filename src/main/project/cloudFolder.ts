import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudProvider } from '@shared/cloudSync'

/**
 * Whether a project folder lives in a cloud-synced folder (2026-10-08; decided by Claude,
 * unconfirmed). Such a project is worked on through a local copy of its database
 * (`workingCopy.ts`). Detection leans towards "synced": a false positive only costs a copy, a
 * false negative is the "disk I/O error" the author hit on Google Drive.
 */

/** What detection needs of the machine; injectable so tests cover every platform. */
export interface CloudProbe {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Text naming the volume label of a Windows drive root such as `G:\` (`vol` output), or null. */
  volumeLabel: (root: string) => string | null
  exists: (file: string) => boolean
}

const labels = new Map<string, string | null>()

/** `vol G:` prints "Volume in drive G is Google Drive"; the label is all we need of it. */
function windowsVolumeLabel(root: string): string | null {
  const drive = /^([A-Za-z]):/.exec(root)?.[1]?.toUpperCase()
  if (drive === undefined) return null
  if (labels.has(drive)) return labels.get(drive) ?? null
  let label: string | null
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', 'vol', `${drive}:`], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    })
    // The first line names the label in the system language; only the label itself matters.
    label = out.split(/\r?\n/).find((l) => l.trim().length > 0) ?? null
  } catch {
    label = null
  }
  labels.set(drive, label)
  return label
}

export const defaultCloudProbe = (): CloudProbe => ({
  platform: process.platform,
  env: process.env,
  volumeLabel: windowsVolumeLabel,
  exists: (file) => fs.existsSync(file)
})

const GOOGLE_SEGMENTS = new Set(['my drive', 'shared drives', 'googledrive', 'other computers'])
const ICLOUD_SEGMENTS = new Set(['iclouddrive', 'icloud drive', 'mobile documents'])

/** Splits on both separators, so a Windows path is read the same on any platform. */
function segmentsOf(folder: string): string[] {
  return folder.split(/[\\/]+/).filter((s) => s.length > 0)
}

function normalized(folder: string, windows: boolean): string {
  const unified = folder.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return windows ? unified.toLowerCase() : unified
}

function isUnder(folder: string, root: string | undefined, windows: boolean): boolean {
  if (root === undefined || root.trim() === '') return false
  const a = normalized(folder, windows)
  const b = normalized(root, windows)
  return a === b || a.startsWith(`${b}/`)
}

/** The provider syncing `folder`, or null for a plain folder. */
export function cloudProviderFor(
  folder: string,
  probe: CloudProbe = defaultCloudProbe()
): CloudProvider | null {
  const windows = probe.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(folder)
  const segments = segmentsOf(folder)
  const lower = segments.map((s) => s.toLowerCase())

  // macOS File Provider: ~/Library/CloudStorage/GoogleDrive-…, OneDrive-…, Dropbox…
  const storage = lower.indexOf('cloudstorage')
  if (storage > 0 && lower[storage - 1] === 'library') {
    const next = lower[storage + 1] ?? ''
    if (next.startsWith('googledrive')) return 'googleDrive'
    if (next.startsWith('onedrive')) return 'oneDrive'
    if (next.startsWith('dropbox')) return 'dropbox'
  }

  if (lower.some((s) => GOOGLE_SEGMENTS.has(s))) return 'googleDrive'
  if (probe.platform === 'win32' && /^[A-Za-z]:/.test(folder)) {
    if (/google drive/i.test(probe.volumeLabel(folder.slice(0, 3)) ?? '')) return 'googleDrive'
  }

  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (isUnder(folder, probe.env[name], windows)) return 'oneDrive'
  }
  if (lower.some((s) => s.startsWith('onedrive'))) return 'oneDrive'

  if (lower.some((s) => ICLOUD_SEGMENTS.has(s) || s === 'com~apple~clouddocs')) return 'iCloud'

  if (lower.some((s) => s === 'dropbox' || s.startsWith('dropbox ('))) return 'dropbox'
  // A Dropbox folder with another name still holds `.dropbox` at its root.
  const paths = windows ? path.win32 : path.posix
  let dir = paths.resolve(folder)
  for (;;) {
    if (probe.exists(paths.join(dir, '.dropbox'))) return 'dropbox'
    const parent = paths.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
