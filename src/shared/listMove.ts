/**
 * The list with the item at `from` moved to position `to` (clamped into the list). The same array
 * when `from` is not a position in it or the item would land where it already is, so a caller can
 * tell "nothing changed" by identity. Shared by the reference pins (F-9.6) and the timeline
 * events (F-11.2).
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list
  const target = Math.min(list.length - 1, Math.max(0, Math.trunc(to)))
  if (target === from) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return list
  next.splice(target, 0, moved)
  return next
}
