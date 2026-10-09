/**
 * The review deck's model (2026-10-08, the author's "one decision at a time"): pure helpers over
 * the items a review screen hands the deck, so the stepping rules are one owner and testable on
 * their own. The deck holds only where the author is; every decision lives with the screen's
 * own store (Organise, the upload review, edit passes).
 */

/**
 * Where an item stands. `pending` waits for a decision; `skipped` is "later" and stays
 * reviewable; `accepted` and `rejected` are decided; an item whose fate was settled outside the
 * deck (applied in Auto, undone, out of date) is `settled` and is shown without buttons.
 */
export type ReviewDecision = 'pending' | 'accepted' | 'skipped' | 'rejected'

export interface ReviewDeckItem {
  id: string
  /** The group (rail entry) the item belongs to. */
  group: string
  decision: ReviewDecision
  /** Settled outside the deck: shown, counted as reviewed, never decided here. */
  settled?: boolean
}

export interface ReviewDeckGroup {
  id: string
  /** The rail's label ("Merges"). */
  label: string
  /** What one item is called in the card's heading ("Merge" → "Merge 3 of 12"); the label otherwise. */
  noun?: string
}

/** Which items the deck steps through: all of them, or only the skipped ones. */
export type ReviewFilter = 'all' | 'skipped'

/** Whether an item still waits for the author. */
export const isOpen = (item: ReviewDeckItem): boolean =>
  item.settled !== true && item.decision === 'pending'

/** Whether an item counts as reviewed for the progress: decided, skipped, or settled. */
export const isReviewed = (item: ReviewDeckItem): boolean => !isOpen(item)

/** Whether an item is in the filter. */
export const inFilter = (item: ReviewDeckItem, filter: ReviewFilter): boolean =>
  filter === 'all' || (item.settled !== true && item.decision === 'skipped')

/** The rail: each group that has items, in the given order, with how many are reviewed. */
export function groupStats(
  items: readonly ReviewDeckItem[],
  groups: readonly ReviewDeckGroup[]
): { group: ReviewDeckGroup; total: number; reviewed: number }[] {
  return groups.flatMap((group) => {
    const mine = items.filter((item) => item.group === group.id)
    if (mine.length === 0) return []
    return [{ group, total: mine.length, reviewed: mine.filter(isReviewed).length }]
  })
}

/** Items in rail order: by group as the rail lists them, then as given. */
export function deckOrder(
  items: readonly ReviewDeckItem[],
  groups: readonly ReviewDeckGroup[]
): ReviewDeckItem[] {
  const rank = new Map(groups.map((group, i) => [group.id, i]))
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        (rank.get(a.item.group) ?? groups.length) - (rank.get(b.item.group) ?? groups.length) ||
        a.i - b.i
    )
    .map(({ item }) => item)
}

/**
 * The item to show after `fromId`: the next one still waiting (in the filter: the next skipped
 * one) after it, wrapping round to the start; null when none waits.
 */
export function nextOpen(
  ordered: readonly ReviewDeckItem[],
  fromId: string | null,
  filter: ReviewFilter
): string | null {
  const wanted = (item: ReviewDeckItem): boolean =>
    filter === 'skipped' ? inFilter(item, 'skipped') : isOpen(item)
  const from = fromId === null ? -1 : ordered.findIndex((item) => item.id === fromId)
  for (let step = 1; step <= ordered.length; step++) {
    const item = ordered[(from + step + ordered.length) % ordered.length]
    if (item !== undefined && item.id !== fromId && wanted(item)) return item.id
  }
  return null
}

/** The neighbour of `id` in the filter, one step back (-1) or on (+1), without wrapping. */
export function neighbour(
  ordered: readonly ReviewDeckItem[],
  id: string | null,
  step: -1 | 1,
  filter: ReviewFilter
): string | null {
  const list = ordered.filter((item) => inFilter(item, filter))
  if (list.length === 0) return null
  const at = id === null ? -1 : list.findIndex((item) => item.id === id)
  if (at === -1) return (step === 1 ? list[0] : list[list.length - 1])?.id ?? null
  return list[at + step]?.id ?? null
}

/** The items with `ids` decided as `decision`: what the owner will hold once it has applied the decision. */
export function withDecision(
  items: readonly ReviewDeckItem[],
  ids: readonly string[],
  decision: ReviewDecision
): ReviewDeckItem[] {
  const set = new Set(ids)
  return items.map((item) => (set.has(item.id) && !item.settled ? { ...item, decision } : item))
}

/**
 * Counts for the progress bar, the Apply button (`accepted`: accepted and not yet applied), and
 * the end's summary (`acceptedTotal`: applied ones too).
 */
export function deckCounts(items: readonly ReviewDeckItem[]): {
  total: number
  reviewed: number
  accepted: number
  acceptedTotal: number
  skipped: number
  open: number
} {
  const live = items.filter((item) => item.settled !== true)
  return {
    total: items.length,
    reviewed: items.filter(isReviewed).length,
    accepted: live.filter((item) => item.decision === 'accepted').length,
    acceptedTotal: items.filter((item) => item.decision === 'accepted').length,
    skipped: live.filter((item) => item.decision === 'skipped').length,
    open: items.filter(isOpen).length
  }
}

/** The open (pending or skipped) items of a group: what "Accept group" accepts. */
export function groupOpenIds(items: readonly ReviewDeckItem[], groupId: string): string[] {
  return items
    .filter(
      (item) =>
        item.group === groupId &&
        item.settled !== true &&
        (item.decision === 'pending' || item.decision === 'skipped')
    )
    .map((item) => item.id)
}
