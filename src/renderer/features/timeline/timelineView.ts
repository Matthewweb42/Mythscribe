import { TIMELINE_YEAR_LIMIT, type TimelineEvent } from '@shared/timeline'

/**
 * The pure arithmetic of the Timeline tab (F-11.2). `eventOf(id)` answers the event id a node's
 * scene metadata links to, or undefined; a link to an event the timeline no longer has reads as
 * unlinked everywhere here.
 */
export type EventOf = (id: string) => string | undefined

/** The event a node is on, when that event still exists: `eventId` checked against the list. */
export function linkedEventId(
  events: readonly TimelineEvent[],
  eventId: string | undefined
): string | undefined {
  return eventId !== undefined && events.some((event) => event.id === eventId)
    ? eventId
    : undefined
}

/** Each event's linked nodes, in the reading order of `ids`; every event has an entry. */
export function nodesByEvent(
  events: readonly TimelineEvent[],
  ids: readonly string[],
  eventOf: EventOf
): Map<string, string[]> {
  const map = new Map<string, string[]>(events.map((event) => [event.id, []]))
  for (const id of ids) {
    const eventId = eventOf(id)
    if (eventId !== undefined) map.get(eventId)?.push(id)
  }
  return map
}

/** How many of `documentIds` sit on no (existing) event. */
export function unplacedCount(
  events: readonly TimelineEvent[],
  documentIds: readonly string[],
  eventOf: EventOf
): number {
  const known = new Set(events.map((event) => event.id))
  return documentIds.filter((id) => {
    const eventId = eventOf(id)
    return eventId === undefined || !known.has(eventId)
  }).length
}

/**
 * The events whose year is lower than an earlier event's year: the author's order says later,
 * the years say earlier. Events without a year neither warn nor raise the bar.
 */
export function yearWarnings(events: readonly TimelineEvent[]): Set<string> {
  const warned = new Set<string>()
  let latest: number | null = null
  for (const event of events) {
    if (event.year === null) continue
    if (latest !== null && event.year < latest) warned.add(event.id)
    else latest = event.year
  }
  return warned
}

/** One row of the reading-order view: a document, its event's position on the timeline, and whether it is a flashback. */
export interface ReadingOrderRow {
  id: string
  /** The index of the node's event in the timeline, or null when it sits on none. */
  eventIndex: number | null
  /** True when its event comes before the latest event of a document read earlier. */
  flashback: boolean
}

/** The documents in reading order, each placed on the timeline, with the rows set earlier than one before them flagged. */
export function readingOrderRows(
  events: readonly TimelineEvent[],
  documentIds: readonly string[],
  eventOf: EventOf
): ReadingOrderRow[] {
  const indexOf = new Map(events.map((event, index) => [event.id, index]))
  let latest = -1
  return documentIds.map((id) => {
    const eventId = eventOf(id)
    const eventIndex = eventId === undefined ? null : (indexOf.get(eventId) ?? null)
    if (eventIndex === null) return { id, eventIndex, flashback: false }
    const flashback = eventIndex < latest
    latest = Math.max(latest, eventIndex)
    return { id, eventIndex, flashback }
  })
}

/**
 * The year field's text as a story year: blank is no year (null), a whole number within
 * `TIMELINE_YEAR_LIMIT` is that year, anything else is `'invalid'` and keeps the form from saving.
 */
export function parseYear(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^-?\d+$/.test(trimmed)) return 'invalid'
  const year = Number(trimmed)
  return Math.abs(year) <= TIMELINE_YEAR_LIMIT ? year : 'invalid'
}
