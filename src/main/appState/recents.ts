import {
  RECENTS_MAX,
  type ProjectInfo,
  type RecentProject,
  type RecentProjectEntry
} from '@shared/ipc/contract'

/** Puts `entry` at the front, replacing any entry with the same path, and caps the list. */
export function touchRecent(
  list: readonly RecentProjectEntry[],
  entry: RecentProjectEntry
): RecentProjectEntry[] {
  return [entry, ...list.filter((r) => r.path !== entry.path)].slice(0, RECENTS_MAX)
}

export function removeRecent(
  list: readonly RecentProjectEntry[],
  path: string
): RecentProjectEntry[] {
  return list.filter((r) => r.path !== path)
}

export function toRecentEntry(info: ProjectInfo): RecentProjectEntry {
  return { path: info.path, name: info.name, format: info.format, lastOpened: info.lastOpened }
}

export function withExists(
  list: readonly RecentProjectEntry[],
  exists: (path: string) => boolean
): RecentProject[] {
  return list.map((r) => ({ ...r, exists: exists(r.path) }))
}
