import { eq, gte, isNotNull, sql } from 'drizzle-orm'
import { addDays, localDay } from '@shared/goals'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import {
  nameKey,
  sceneLengthStats,
  STATS_LOG_DAYS,
  STATS_ROWS_MAX,
  tallyPov,
  type AppearanceRow,
  type StatsDashboard,
  type StatsHour
} from '@shared/statsDashboard'
import type { TagCategory } from '@shared/tags'
import { documentTag, entity, tag, tagMention, writingLog } from '../db/schema'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * The statistics dashboard (F-10.5), main side: one content-free read of the writing log, the
 * manuscript documents' stored word counts and scene metadata, the character and setting tags
 * with their links and mentions, and the entities named after those tags. Only documents under
 * the manuscript count; front and end matter never do.
 */

interface Scene {
  id: string
  words: number
  pov: string
  location: string
}

interface Tally {
  tagId: string | null
  name: string
  /** Every name the row answers to, folded by `nameKey`. */
  keys: Set<string>
  scenes: Set<string>
  mentions: number
  povScenes: number
}

/** The writing log: the days of the last `STATS_LOG_DAYS` and the whole log by hour of day. */
function writingStats(db: TreeDb, today: string): Pick<StatsDashboard, 'days' | 'hours'> {
  const since = addDays(today, -(STATS_LOG_DAYS - 1))
  const days = db
    .select({
      day: writingLog.day,
      words: sql<number>`SUM(${writingLog.words})`,
      activeMs: sql<number>`SUM(${writingLog.activeMs})`
    })
    .from(writingLog)
    .where(gte(writingLog.day, since))
    .groupBy(writingLog.day)
    .orderBy(writingLog.day)
    .all()
    .map((row) => ({ day: row.day, words: Number(row.words), activeMs: Number(row.activeMs) }))
  const byHour = db
    .select({
      hour: writingLog.hour,
      words: sql<number>`SUM(CASE WHEN ${writingLog.words} > 0 THEN ${writingLog.words} ELSE 0 END)`,
      activeMs: sql<number>`SUM(${writingLog.activeMs})`
    })
    .from(writingLog)
    .groupBy(writingLog.hour)
    .all()
  const hours: StatsHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    words: 0,
    activeMs: 0
  }))
  for (const row of byHour) {
    const slot = hours[row.hour]
    if (slot === undefined) continue
    slot.words = Number(row.words)
    slot.activeMs = Number(row.activeMs)
  }
  return { days, hours }
}

/** One tally per tag of `category`, named after its entity when one carries the tag. */
function tagTallies(
  db: TreeDb,
  category: TagCategory,
  entityNames: ReadonlyMap<string, string>
): Map<string, Tally> {
  const tallies = new Map<string, Tally>()
  for (const row of db
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .where(eq(tag.category, category))
    .all()) {
    const display = entityNames.get(row.id) ?? row.name
    tallies.set(row.id, {
      tagId: row.id,
      name: display,
      keys: new Set([nameKey(display), nameKey(row.name)]),
      scenes: new Set(),
      mentions: 0,
      povScenes: 0
    })
  }
  return tallies
}

/** Sorted by scenes, then mentions, then name; capped at `STATS_ROWS_MAX`. */
function finish(
  tallies: Iterable<Tally>,
  withPov: boolean
): { rows: AppearanceRow[]; truncated: boolean } {
  const rows = [...tallies]
    .map((t) => ({
      tagId: t.tagId,
      name: t.name,
      scenes: t.scenes.size,
      mentions: t.mentions,
      ...(withPov ? { povScenes: t.povScenes } : {})
    }))
    .sort((a, b) => b.scenes - a.scenes || b.mentions - a.mentions || a.name.localeCompare(b.name))
  return { rows: rows.slice(0, STATS_ROWS_MAX), truncated: rows.length > STATS_ROWS_MAX }
}

/** Everything the dashboard shows, as of `now` on the local clock. */
export function statsDashboard(db: TreeDb, now: Date = new Date()): StatsDashboard {
  const today = localDay(now)
  const documents = manuscriptDocuments(db, listNodes(db))
  const scenes: Scene[] = documents.map((row) => {
    const meta = parseStoredSceneMeta(row.sceneMeta)
    return { id: row.id, words: row.wordCount, pov: meta.pov, location: meta.location }
  })
  const inManuscript = new Set(scenes.map((s) => s.id))

  const entityNames = new Map<string, string>()
  for (const row of db
    .select({ name: entity.name, tagId: entity.tagId })
    .from(entity)
    .where(isNotNull(entity.tagId))
    .all())
    if (row.tagId !== null && !entityNames.has(row.tagId)) entityNames.set(row.tagId, row.name)

  const characters = tagTallies(db, 'character', entityNames)
  const settings = tagTallies(db, 'setting', entityNames)
  const tallyOf = (tagId: string): Tally | undefined => characters.get(tagId) ?? settings.get(tagId)

  // Links and mentions are read whole and restricted here: no id list bound into the query.
  for (const link of db
    .select({ nodeId: documentTag.nodeId, tagId: documentTag.tagId })
    .from(documentTag)
    .all())
    if (inManuscript.has(link.nodeId)) tallyOf(link.tagId)?.scenes.add(link.nodeId)
  for (const mention of db
    .select({ nodeId: tagMention.nodeId, tagId: tagMention.tagId, count: tagMention.count })
    .from(tagMention)
    .all()) {
    const tally = inManuscript.has(mention.nodeId) ? tallyOf(mention.tagId) : undefined
    if (tally === undefined) continue
    tally.scenes.add(mention.nodeId)
    tally.mentions += mention.count
  }

  // POV scenes per character, and scene locations: a setting by name, else a row of its own.
  const locations = new Map<string, Tally>()
  for (const scene of scenes) {
    const pov = nameKey(scene.pov)
    if (pov !== '')
      for (const tally of characters.values()) {
        if (!tally.keys.has(pov)) continue
        // The POV character is in the scene even when the text never names them.
        tally.povScenes += 1
        tally.scenes.add(scene.id)
      }
    const location = nameKey(scene.location)
    if (location === '') continue
    let matched = false
    for (const tally of settings.values()) {
      if (!tally.keys.has(location)) continue
      tally.scenes.add(scene.id)
      matched = true
    }
    if (matched) continue
    const own = locations.get(location) ?? {
      tagId: null,
      name: scene.location.trim(),
      keys: new Set([location]),
      scenes: new Set<string>(),
      mentions: 0,
      povScenes: 0
    }
    own.scenes.add(scene.id)
    locations.set(location, own)
  }

  const characterRows = finish(characters.values(), true)
  const settingRows = finish([...settings.values(), ...locations.values()], false)
  return {
    today,
    ...writingStats(db, today),
    scenes: sceneLengthStats(
      documents.map((row) => ({ id: row.id, title: row.title, words: row.wordCount }))
    ),
    pov: tallyPov(scenes),
    characters: characterRows.rows,
    settings: settingRows.rows,
    truncated: { characters: characterRows.truncated, settings: settingRows.truncated }
  }
}
