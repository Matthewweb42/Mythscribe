import { z } from 'zod'
import { toEntityNameKey, type EntityFields } from './entities'
import { moveItem } from './listMove'

/**
 * The story timeline (F-11.2): the project's events in story order, stored as one JSON value in
 * the project `settings` row under `TIMELINE_KEY` (no migration). The array order is the story's
 * chronology, set by the author; `when` is free text ("Spring", "Day 3") and `year` an optional
 * whole number for the year check and, later, character ages (F-11.2b). A scene links to an
 * event through `SceneMeta.eventId`; its `timeline` text stays the event's `eventText`, which is
 * what prompts read, and main rewrites it whenever the event changes. One owner for the shape,
 * the caps, and the list arithmetic, so main and the renderer agree on what a duplicate is.
 */

/** The `settings` row key the timeline lives under. */
export const TIMELINE_KEY = 'timeline'

/** Most events a project keeps. */
export const TIMELINE_EVENTS_MAX = 500
export const TIMELINE_LABEL_MAX = 200
export const TIMELINE_WHEN_MAX = 100
export const TIMELINE_NOTE_MAX = 1000
/** The longest event id a scene may store; generated ids (UUIDs) are far shorter. */
export const TIMELINE_EVENT_ID_MAX = 64
/** The furthest a story year may sit from year 0, either way. */
export const TIMELINE_YEAR_LIMIT = 1_000_000
/** The longest `eventText` can be: the `when`, ": ", and the label. Stays within the scene's timeline field. */
export const TIMELINE_EVENT_TEXT_MAX = TIMELINE_WHEN_MAX + 2 + TIMELINE_LABEL_MAX

export const TimelineEvent = z.object({
  id: z.string().min(1).max(TIMELINE_EVENT_ID_MAX),
  label: z.string().trim().min(1, 'An event needs a name').max(TIMELINE_LABEL_MAX),
  when: z.string().trim().max(TIMELINE_WHEN_MAX),
  year: z.number().int().min(-TIMELINE_YEAR_LIMIT).max(TIMELINE_YEAR_LIMIT).nullable(),
  note: z.string().max(TIMELINE_NOTE_MAX)
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

/**
 * Why `events` cannot be stored, or null when it can: two events with one id, or two whose labels
 * are the same once trimmed, spacing collapsed, and lower-cased (the entities' name key), since
 * the picker tells events apart by their text.
 */
export function timelineProblem(events: readonly TimelineEvent[]): string | null {
  const ids = new Set<string>()
  const labels = new Set<string>()
  for (const event of events) {
    if (ids.has(event.id)) return 'Two timeline events share one id'
    ids.add(event.id)
    const key = toEntityNameKey(event.label)
    if (labels.has(key)) return `There is already an event called "${event.label.trim()}"`
    labels.add(key)
  }
  return null
}

export const ProjectTimeline = z
  .object({ events: z.array(TimelineEvent).max(TIMELINE_EVENTS_MAX) })
  .superRefine((value, ctx) => {
    const problem = timelineProblem(value.events)
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
  })
export type ProjectTimeline = z.infer<typeof ProjectTimeline>

/** The empty timeline a project without a stored row (or with an unreadable one) starts from. */
export function defaultProjectTimeline(): ProjectTimeline {
  return { events: [] }
}

/** The text a linked scene's Timeline field holds for `event`: "When: Label", or the label alone. */
export function eventText(event: Pick<TimelineEvent, 'label' | 'when'>): string {
  const label = event.label.trim()
  const when = event.when.trim()
  return when ? `${when}: ${label}` : label
}

/** The event whose `eventText` is exactly `text`, or null: picking an option links, typing anything else does not. */
export function eventForText(events: readonly TimelineEvent[], text: string): TimelineEvent | null {
  return events.find((event) => eventText(event) === text) ?? null
}

/**
 * The list with `event` appended. An event whose id is already in it, or a list already at
 * `TIMELINE_EVENTS_MAX`, answers the same array, so a caller can tell "nothing changed" by identity.
 */
export function addEvent(
  events: readonly TimelineEvent[],
  event: TimelineEvent
): readonly TimelineEvent[] {
  if (events.length >= TIMELINE_EVENTS_MAX || events.some((other) => other.id === event.id))
    return events
  return [...events, event]
}

/** The list with event `id` changed by `patch`; the same array when it is not there or nothing changes. */
export function updateEvent(
  events: readonly TimelineEvent[],
  id: string,
  patch: Partial<Omit<TimelineEvent, 'id'>>
): readonly TimelineEvent[] {
  const index = events.findIndex((event) => event.id === id)
  const current = events[index]
  if (current === undefined) return events
  const next = { ...current, ...patch }
  if (
    next.label === current.label &&
    next.when === current.when &&
    next.year === current.year &&
    next.note === current.note
  )
    return events
  return events.map((event, at) => (at === index ? next : event))
}

/** The list without event `id`; the same array when it was not in it. */
export function removeEvent(
  events: readonly TimelineEvent[],
  id: string
): readonly TimelineEvent[] {
  return events.some((event) => event.id === id)
    ? events.filter((event) => event.id !== id)
    : events
}

/** The list with the event at `from` moved to `to` (clamped); the same array when nothing moves. */
export function moveEvent(
  events: readonly TimelineEvent[],
  from: number,
  to: number
): readonly TimelineEvent[] {
  return moveItem(events, from, to)
}

/**
 * A story year typed as text (the timeline's year input, a character's `born` field): blank is no
 * year (null), a whole number within `TIMELINE_YEAR_LIMIT` is that year, anything else is
 * `'invalid'` ("Year 1170" included), so the form refuses it and ages are not computed from it.
 */
export function parseYear(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^-?\d+$/.test(trimmed)) return 'invalid'
  const year = Number(trimmed)
  return Math.abs(year) <= TIMELINE_YEAR_LIMIT ? year : 'invalid'
}

/** A character's age in story year `year` when born in `born` (F-11.2b); negative = not born yet. */
export function ageAt(born: number, year: number): number {
  return year - born
}

/** A character's birth year from the sheet's `born` field, or null when it is blank or not a whole number. */
export function characterBirthYear(entity: { fields: EntityFields }): number | null {
  const year = parseYear(entity.fields.born ?? '')
  return year === 'invalid' ? null : year
}
