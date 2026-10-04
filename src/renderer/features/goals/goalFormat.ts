/** `under a minute`, `12 min`, `1 h 05 min`: the session's active writing time (F-10.3). */
export function formatActiveTime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** `1 day`, `12 days`. */
export function formatDays(days: number): string {
  return `${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}`
}
