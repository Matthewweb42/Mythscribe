/**
 * When a backup was made, as Settings › Backups lists it (F-8.7): the row's date, its Restore
 * button's label, and the switch-over's way back (F-16.31), which names the backup the same way.
 */
export function backupWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
