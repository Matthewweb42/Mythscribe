import { toEntityNameKey } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { ageAt, characterBirthYear, type TimelineEvent } from '@shared/timeline'

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
  return eventId !== undefined && events.some((event) => event.id === eventId) ? eventId : undefined
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

/** One character's age at an event (F-11.2b); negative = not born yet. */
export interface EventAge {
  entityId: string
  name: string
  age: number
}

/**
 * The ages at each event with a year (F-11.2b), per event id, sorted by name: every character
 * with a whole-number birth year whose entity tag is linked to one of the event's nodes, or whose
 * name is a linked node's POV (same name key). Inline mentions are not consulted. Events without
 * a year, or with no such character, have no entry.
 */
export function eventAges(
  events: readonly TimelineEvent[],
  linked: ReadonlyMap<string, readonly string[]>,
  entities: readonly Pick<Entity, 'id' | 'kind' | 'name' | 'fields' | 'tagId'>[],
  tagIdsOf: (nodeId: string) => readonly string[] | undefined,
  povOf: (nodeId: string) => string | undefined
): Map<string, EventAge[]> {
  const characters = entities.flatMap((entity) => {
    const born = entity.kind === 'character' ? characterBirthYear(entity) : null
    return born === null ? [] : [{ entity, born, key: toEntityNameKey(entity.name) }]
  })
  const map = new Map<string, EventAge[]>()
  if (characters.length === 0) return map
  for (const event of events) {
    const year = event.year
    if (year === null) continue
    const nodeIds = linked.get(event.id) ?? []
    const tags = new Set(nodeIds.flatMap((id) => tagIdsOf(id) ?? []))
    const povs = new Set(nodeIds.map((id) => toEntityNameKey(povOf(id) ?? '')))
    const ages = characters
      .filter(
        ({ entity, key }) => (entity.tagId !== null && tags.has(entity.tagId)) || povs.has(key)
      )
      .map(({ entity, born }) => ({
        entityId: entity.id,
        name: entity.name,
        age: ageAt(born, year)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (ages.length > 0) map.set(event.id, ages)
  }
  return map
}

/** An age as the timeline shows it: the number, or "not born yet". */
export function ageText(age: number): string {
  return age < 0 ? 'not born yet' : String(age)
}

/** The events with a year, in story order, each with the age of a character born in `born`. */
export function agesOnTimeline(
  events: readonly TimelineEvent[],
  born: number
): { event: TimelineEvent; year: number; age: number }[] {
  return events.flatMap((event) =>
    event.year === null ? [] : [{ event, year: event.year, age: ageAt(born, event.year) }]
  )
}
