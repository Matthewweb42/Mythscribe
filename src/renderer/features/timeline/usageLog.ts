import { toEntityNameKey } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import type { TimelineEvent } from '@shared/timeline'
import type { EventOf } from './timelineView'

/**
 * The pure arithmetic of the appearance and location logs (F-11.2c). Everything works on the
 * manuscript documents in reading order and on lookups the caller builds from the stores it
 * already holds (document tags, recorded mentions, scene metadata), so the entity page and the
 * Timeline tab read the same rules.
 */

/** How an entity appears in one document; at least one of the three holds for a row. */
export interface AppearanceHow {
  /** Its entity tag is linked to the document (F-4.4). */
  linked: boolean
  /** How often main's scan found its name in the document (F-4.12); 0 when none. */
  mentions: number
  /** The document's POV names it (characters only). */
  pov: boolean
}

/** One document an entity appears in. */
export interface AppearanceRow {
  nodeId: string
  how: AppearanceHow
}

/** The entity as the logs need it. */
export type UsageEntity = Pick<Entity, 'id' | 'kind' | 'name' | 'tagId'>

/** True when `text` names the entity: the same name key, never for blank text. */
export function namesEntity(text: string | undefined, name: string): boolean {
  const key = toEntityNameKey(text ?? '')
  return key !== '' && key === toEntityNameKey(name)
}

/**
 * The documents of `documentIds` (in the order given) the entity appears in: its tag is linked there,
 * its name was scanned there, or — for a character — the document's POV names it.
 */
export function appearancesOf(
  entity: UsageEntity,
  documentIds: readonly string[],
  tagIdsOf: (nodeId: string) => readonly string[] | undefined,
  mentionsIn: (nodeId: string) => number,
  povOf: (nodeId: string) => string | undefined
): AppearanceRow[] {
  const tagId = entity.tagId
  return documentIds.flatMap((nodeId) => {
    const how: AppearanceHow = {
      linked: tagId !== null && (tagIdsOf(nodeId)?.includes(tagId) ?? false),
      mentions: tagId === null ? 0 : mentionsIn(nodeId),
      pov: entity.kind === 'character' && namesEntity(povOf(nodeId), entity.name)
    }
    return how.linked || how.mentions > 0 || how.pov ? [{ nodeId, how }] : []
  })
}

/** The documents of `documentIds` (reading order) whose Location names the setting. */
export function scenesSetAt(
  name: string,
  documentIds: readonly string[],
  locationOf: (nodeId: string) => string | undefined
): string[] {
  return documentIds.filter((nodeId) => namesEntity(locationOf(nodeId), name))
}

/** One group of the story-order log: an event and its rows, or `event: null` for the rest. */
export interface StoryGroup<T> {
  event: TimelineEvent | null
  rows: T[]
}

/**
 * `rows` (reading order) grouped by their document's event, the events in story order; events
 * without a row are left out, and the rows on no (existing) event come last under `event: null`,
 * still in reading order.
 */
export function inStoryOrder<T extends { nodeId: string }>(
  rows: readonly T[],
  events: readonly TimelineEvent[],
  eventOf: EventOf
): StoryGroup<T>[] {
  const byEvent = new Map<string, T[]>(events.map((event) => [event.id, []]))
  const unplaced: T[] = []
  for (const row of rows) {
    const eventId = eventOf(row.nodeId)
    const bucket = eventId === undefined ? undefined : byEvent.get(eventId)
    if (bucket) bucket.push(row)
    else unplaced.push(row)
  }
  const groups: StoryGroup<T>[] = events.flatMap((event) => {
    const grouped = byEvent.get(event.id) ?? []
    return grouped.length === 0 ? [] : [{ event, rows: grouped }]
  })
  if (unplaced.length > 0) groups.push({ event: null, rows: unplaced })
  return groups
}

/** A character in two or more different locations at one event. */
export interface LocationConflict {
  eventId: string
  entityId: string
  name: string
  /** The locations as first written, one per name key, in reading order. */
  locations: string[]
}

/**
 * The location conflicts (F-11.2c, display only): for each event in story order, each character
 * of `characters` that appears in two or more of the event's linked nodes whose Locations
 * (non-empty, compared by name key) differ. Characters are taken in the order given.
 */
export function locationConflicts(
  events: readonly TimelineEvent[],
  linked: ReadonlyMap<string, readonly string[]>,
  characters: readonly UsageEntity[],
  appearsIn: (entity: UsageEntity, nodeId: string) => boolean,
  locationOf: (nodeId: string) => string | undefined
): LocationConflict[] {
  const conflicts: LocationConflict[] = []
  for (const event of events) {
    const nodeIds = linked.get(event.id) ?? []
    if (nodeIds.length < 2) continue
    for (const entity of characters) {
      if (entity.kind !== 'character') continue
      const locations = new Map<string, string>()
      for (const nodeId of nodeIds) {
        const location = (locationOf(nodeId) ?? '').trim()
        const key = toEntityNameKey(location)
        if (key === '' || locations.has(key) || !appearsIn(entity, nodeId)) continue
        locations.set(key, location)
      }
      if (locations.size > 1) {
        conflicts.push({
          eventId: event.id,
          entityId: entity.id,
          name: entity.name,
          locations: [...locations.values()]
        })
      }
    }
  }
  return conflicts
}

/**
 * Whether a character appears in a document by the logs' rules, from the lookups the caller
 * holds: its tag linked or mentioned there, or the POV naming it.
 */
export function appearsBy(
  tagIdsOf: (nodeId: string) => readonly string[] | undefined,
  mentionedIn: (tagId: string, nodeId: string) => boolean,
  povOf: (nodeId: string) => string | undefined
): (entity: UsageEntity, nodeId: string) => boolean {
  return (entity, nodeId) => {
    const tagId = entity.tagId
    if (
      tagId !== null &&
      (tagIdsOf(nodeId)?.includes(tagId) === true || mentionedIn(tagId, nodeId))
    )
      return true
    return entity.kind === 'character' && namesEntity(povOf(nodeId), entity.name)
  }
}
