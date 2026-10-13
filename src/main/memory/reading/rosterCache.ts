import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { estimateTokens } from '@shared/ai'
import { normName } from '@shared/memory/names'
import type { RecordOrigin, StoryRecordSummary } from '@shared/memory/records'
import { readerMayRead } from '@shared/memory/sources'
import {
  TOPIC_ID_PREFIX,
  TOPIC_LABEL_SHORT_WORDS,
  TOPIC_ROSTER_MAX_TOKENS,
  TOPIC_ROSTER_TOKENS,
  TopicKind,
  topicLabel,
  topicLinesTokens,
  topicRosterLine
} from '@shared/memory/topics'
import { settings } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'
import { readerRosterAddition, readerRosterLine } from '../../ai/prompts/reader.v1'
import { READER_V2_PROMPT_VERSION } from '../../ai/prompts/reader.v2'
import { currentDraftId } from '../../draft/draftStore'
import { namedTotals } from '../nameIndexer'
import { listRecords } from '../recordStore'
import { claimSources } from './claimStore'
import { topicsInDraft } from './recordEvidence'
import { MEMORY_ROSTER_KEY } from './roster'

/**
 * The reader's roster cache (F-16.17; plan P2a §2.5): the roster block of the reader (`reader.v2`
 * since P2b slice 2; the row names the version, so a new one rebuilds it once) is kept in a
 * settings row (`memoryRoster`) byte for byte across calls and sessions, so the provider's prompt
 * cache holds the rules and the roster as one stable prefix. A new record or nickname is appended
 * (`r12 +Ry`); a removal, rename, re-categorising, merge, split, *Rebuild memory* or a new reader
 * version rebuilds it (rename, merge, split and delete drop the row through `markRosterForRebuild`;
 * a nickname removed through `record:setAliases` is caught here by comparing). One line per record:
 * `r12 Mara Vell (Mara; Captain Vell) · character`. Characters, places, things, groups and terms
 * share `ROSTER_RECORD_TOKENS`: over it, the least-named records are left out (the reader may still
 * propose one as a name, which the twin gate maps back to it); 400 tokens are held for P2b's secrets
 * and threads. Short ids are never reused within a build of the row.
 *
 * P2b (P2b-D10): the row's `topics` part holds the secrets and threads (`s3 the sold map ·
 * secret`, `t2 Ashby's return · thread`), rendered after the record lines, so a topic made,
 * renamed, merged, split or pruned rebuilds only that part and never moves the record prefix. Past
 * `TOPIC_ROSTER_TOKENS`, every label shortens to 4 words, and what is still over comes out of the
 * near lines' budget, then out of the page (`readerV2PageTokens`); past `TOPIC_ROSTER_MAX_TOKENS`
 * the AI-made topics with the least evidence are left out (the author's last, `dropped`, counted
 * by the reading as `topicRosterLeftOut`), so the reader's request always fits its cap (P2b-D10,
 * amended in review). An AI-made topic is listed only while readable scenes of the active draft
 * back it: one backed only by an Idea scene, a scene left out of compile or text outside the
 * manuscript is not sent (AI rule 3).
 */

/** The records' share of the roster's 1,600 tokens (P2b's secrets and threads hold the other 400). */
export const ROSTER_RECORD_TOKENS = 1_200

const Held = z.object({ name: z.string(), kind: z.string(), names: z.array(z.string()) })

const HeldTopic = z.object({ label: z.string(), kind: TopicKind })

/** The topics part (P2b-D10): its own ids, lines and what each line holds. */
const TopicsPart = z.object({
  /** recordId → short id ("s3", "t2"). */
  ids: z.record(z.string(), z.string()),
  /** The next short id's number per kind. */
  next: z.object({ secret: z.number().int().positive(), thread: z.number().int().positive() }),
  base: z.array(z.string()),
  additions: z.array(z.string()),
  held: z.record(z.string(), HeldTopic),
  /** Labels shortened to fit the budget. */
  short: z.boolean(),
  /** Topics left out past the ceiling (the least evidenced AI-made ones first). */
  dropped: z.array(z.string()).default([])
})
type TopicsPart = z.infer<typeof TopicsPart>

const RosterRow = z.object({
  readerVersion: z.string(),
  /** recordId → short id ("r12"). */
  ids: z.record(z.string(), z.string()),
  /** The next short id's number. */
  next: z.number().int().positive(),
  base: z.array(z.string()),
  additions: z.array(z.string()),
  /** What each listed record's lines hold: its name, kind and every name's norm. */
  held: z.record(z.string(), Held),
  /** Records left out for the cap (least named); a record not here and not held is new. */
  dropped: z.array(z.string()),
  /** P2b: the secrets and threads (rows written before P2b have none: built on first use). */
  topics: TopicsPart.optional()
})
type RosterRow = z.infer<typeof RosterRow>

/** The roster as one reading uses it: the lines to send and the id maps both ways. */
export interface ReaderRoster {
  /** The roster block's lines: the base, then the additions. */
  lines: string[]
  /** A record's short id: its roster id, or one given for this reading only (a record left out). */
  shortOf(recordId: string): string
  /** The record a short id names, or null. */
  recordOf(shortId: string): string | null
  /** A record's roster line with its short id, for the checker's "Who" ("r12 Mara Vell · character"). */
  whoLine(recordId: string): string
  /** P2b: the topics block's lines (after the record lines): the base, then the additions. */
  topicLines: string[]
  /** A secret's or thread's short id ("s3", "t2"); null when it is not a listed topic. */
  topicShortOf(recordId: string): string | null
  /** The topic a short id names, or null. */
  topicOf(shortId: string): string | null
  /** How many topics the roster left out past its ceiling (P2b-D10, amended). */
  topicsLeftOut: number
}

/** A secret or thread as the topics part lists it. */
export interface RosterTopic {
  recordId: string
  kind: z.infer<typeof TopicKind>
  label: string
  created: string
  /** Who made it: the author's are left out last. */
  origin: RecordOrigin
  /** Its evidence in the active draft's readable scenes (reveals, knows lines, steps). */
  weight: number
}

const topicLine = (short: string, topic: RosterTopic, shortLabels: boolean): string =>
  topicRosterLine(
    short,
    shortLabels ? topicLabel(topic.label, TOPIC_LABEL_SHORT_WORDS) : topic.label,
    topic.kind
  )

const byAge = <T extends { created: string; recordId: string }>(a: T, b: T): number =>
  a.created.localeCompare(b.created) || a.recordId.localeCompare(b.recordId)

/**
 * The topics part afresh: every topic oldest first, labels shortened when over the budget; past
 * the ceiling, the AI-made topics with the least evidence are left out (the newest first among
 * equals, the author's last).
 */
export function buildTopics(topics: readonly RosterTopic[]): TopicsPart {
  const ordered = [...topics].sort(byAge)
  const lay = (short: boolean, kept: ReadonlySet<string>): TopicsPart => {
    const next = { secret: 1, thread: 1 }
    const ids: Record<string, string> = {}
    const base: string[] = []
    const listed = ordered.filter((topic) => kept.has(topic.recordId))
    for (const topic of listed) {
      const id = `${TOPIC_ID_PREFIX[topic.kind]}${next[topic.kind]}`
      next[topic.kind] += 1
      ids[topic.recordId] = id
      base.push(topicLine(id, topic, short))
    }
    const held = Object.fromEntries(
      listed.map((topic) => [topic.recordId, { label: topic.label, kind: topic.kind }])
    )
    const dropped = ordered
      .filter((topic) => !kept.has(topic.recordId))
      .map((topic) => topic.recordId)
    return { ids, next, base, additions: [], held, short, dropped }
  }
  const all = new Set(ordered.map((topic) => topic.recordId))
  const full = lay(false, all)
  if (topicLinesTokens(full.base) <= TOPIC_ROSTER_TOKENS) return full
  const kept = new Set(all)
  const dropOrder = [...ordered].sort(
    (a, b) =>
      (a.origin === 'ai' ? 0 : 1) - (b.origin === 'ai' ? 0 : 1) ||
      a.weight - b.weight ||
      b.created.localeCompare(a.created) ||
      b.recordId.localeCompare(a.recordId)
  )
  // Each short line's tokens, summed: the joined lines are within one token a line of it.
  const lineTokens = new Map(
    ordered.map((topic) => [topic.recordId, topicLinesTokens([topicLine('s000', topic, true)]) + 1])
  )
  let size = [...lineTokens.values()].reduce((sum, each) => sum + each, 0)
  for (const topic of dropOrder) {
    if (size <= TOPIC_ROSTER_MAX_TOKENS) break
    kept.delete(topic.recordId)
    size -= lineTokens.get(topic.recordId) ?? 0
  }
  return lay(true, kept)
}

/**
 * The topics part brought up to date: null when it must be rebuilt (a topic gone, relabelled or
 * moved kind, or the lines over the budget), else with every new topic appended.
 */
export function appendTopics(part: TopicsPart, topics: readonly RosterTopic[]): TopicsPart | null {
  const byId = new Map(topics.map((topic) => [topic.recordId, topic]))
  for (const [id, held] of Object.entries(part.held)) {
    const topic = byId.get(id)
    if (topic?.label !== held.label || topic.kind !== held.kind) return null
  }
  const next: TopicsPart = {
    ...part,
    ids: { ...part.ids },
    next: { ...part.next },
    additions: [...part.additions],
    held: { ...part.held }
  }
  for (const topic of [...topics].sort(byAge)) {
    if (next.held[topic.recordId] !== undefined || part.dropped.includes(topic.recordId)) continue
    const id = `${TOPIC_ID_PREFIX[topic.kind]}${next.next[topic.kind]}`
    next.next[topic.kind] += 1
    next.ids[topic.recordId] = id
    next.additions.push(topicLine(id, topic, part.short))
    next.held[topic.recordId] = { label: topic.label, kind: topic.kind }
  }
  const tokens = topicLinesTokens([...next.base, ...next.additions])
  // Over the 400 with full labels: shorten them all; over the ceiling: leave some out afresh.
  if ((!part.short && tokens > TOPIC_ROSTER_TOKENS) || tokens > TOPIC_ROSTER_MAX_TOKENS) return null
  return next
}

/** The kinds P2a's reader reads about; secrets and threads are P2b's. */
const READ_KINDS: ReadonlySet<string> = new Set(['character', 'place', 'thing', 'group', 'term'])

/** A record's line: its name, its nicknames in the order they were added, its kind. */
export function rosterLine(short: string, record: StoryRecordSummary): string {
  return readerRosterLine(short, {
    name: record.name,
    kind: record.kind,
    nicknames: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text)
  })
}

const heldOf = (record: StoryRecordSummary): z.infer<typeof Held> => ({
  name: record.name,
  kind: record.kind,
  names: record.aliases.map((alias) => normName(alias.text))
})

const tokensOf = (lines: readonly string[]): number => estimateTokens(lines.join('\n'))

/** Builds the row afresh: every record in creation order, the least named left out over the cap. */
function build(
  records: readonly StoryRecordSummary[],
  named: ReadonlyMap<string, number>
): RosterRow {
  const ordered = [...records].sort(
    (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)
  )
  const kept = new Set(ordered.map((record) => record.id))
  const lines = (): string[] =>
    ordered
      .filter((record) => kept.has(record.id))
      .map((record, i) => rosterLine(`r${i + 1}`, record))
  // Least named first, the newest first among equals: the cut that keeps the most-read names.
  const dropOrder = [...ordered].sort(
    (a, b) => (named.get(a.id) ?? 0) - (named.get(b.id) ?? 0) || b.created.localeCompare(a.created)
  )
  for (const record of dropOrder) {
    if (tokensOf(lines()) <= ROSTER_RECORD_TOKENS) break
    kept.delete(record.id)
  }
  const listed = ordered.filter((record) => kept.has(record.id))
  return {
    readerVersion: READER_V2_PROMPT_VERSION,
    ids: Object.fromEntries(listed.map((record, i) => [record.id, `r${i + 1}`])),
    next: listed.length + 1,
    base: listed.map((record, i) => rosterLine(`r${i + 1}`, record)),
    additions: [],
    held: Object.fromEntries(listed.map((record) => [record.id, heldOf(record)])),
    dropped: ordered.filter((record) => !kept.has(record.id)).map((record) => record.id)
  }
}

function readRow(db: TreeDb): RosterRow | null {
  const row = db.select().from(settings).where(eq(settings.key, MEMORY_ROSTER_KEY)).get()
  if (row === undefined) return null
  try {
    const parsed = RosterRow.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeRow(db: TreeDb, row: RosterRow): void {
  const value = JSON.stringify(row)
  db.insert(settings)
    .values({ key: MEMORY_ROSTER_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

/**
 * The row brought up to date with `records`: null when it must be rebuilt (a record gone, renamed
 * or re-categorised, a nickname removed, the additions over the cap), else the row with every new
 * record and nickname appended.
 */
function appended(row: RosterRow, records: readonly StoryRecordSummary[]): RosterRow | null {
  const byId = new Map(records.map((record) => [record.id, record]))
  for (const [id, held] of Object.entries(row.held)) {
    const record = byId.get(id)
    if (record?.name !== held.name || record.kind !== held.kind) return null
    const now = new Set(record.aliases.map((alias) => normName(alias.text)))
    if (held.names.some((norm) => !now.has(norm))) return null
  }
  const next: RosterRow = {
    ...row,
    ids: { ...row.ids },
    additions: [...row.additions],
    held: { ...row.held }
  }
  const ordered = [...records].sort(
    (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)
  )
  for (const record of ordered) {
    const held = next.held[record.id]
    if (held === undefined) {
      if (row.dropped.includes(record.id)) continue
      const short = `r${next.next}`
      next.next += 1
      next.ids[record.id] = short
      next.additions.push(rosterLine(short, record))
      next.held[record.id] = heldOf(record)
      continue
    }
    const short = next.ids[record.id]
    if (short === undefined) return null
    const fresh = record.aliases.filter((alias) => !held.names.includes(normName(alias.text)))
    if (fresh.length === 0) continue
    for (const alias of fresh) next.additions.push(readerRosterAddition(short, alias.text))
    next.held[record.id] = {
      ...held,
      names: [...held.names, ...fresh.map((a) => normName(a.text))]
    }
  }
  if (tokensOf([...next.base, ...next.additions]) > ROSTER_RECORD_TOKENS) return null
  return next
}

/**
 * The roster for a reading: the cached row, appended to or rebuilt as the records now stand, and
 * written back when it moved.
 */
export function readerRoster(db: TreeDb): ReaderRoster {
  const all = listRecords(db)
  const records = all.filter((record) => READ_KINDS.has(record.kind))
  // The author's secrets and threads, and the AI's while readable scenes of the active draft back
  // them (one only an inactive draft or an Idea scene revealed was never read as real).
  const draftId = currentDraftId(db)
  const sources = claimSources(db)
  const backed =
    draftId === null
      ? new Map<string, number>()
      : topicsInDraft(db, draftId, (nodeId) => readerMayRead(sources(nodeId)))
  const topics: RosterTopic[] = all.flatMap((record) =>
    (record.kind === 'secret' || record.kind === 'thread') &&
    (record.origin !== 'ai' || backed.has(record.id))
      ? [
          {
            recordId: record.id,
            kind: record.kind,
            label: record.name,
            created: record.created,
            origin: record.origin,
            weight: backed.get(record.id) ?? 0
          }
        ]
      : []
  )
  const stored = readRow(db)
  const current =
    stored !== null && stored.readerVersion === READER_V2_PROMPT_VERSION
      ? appended(stored, records)
      : null
  const base = current ?? build(records, namedTotals(db))
  // The topics part follows on its own: rebuilt when it must be, never moving the record lines.
  const part =
    (base.topics === undefined ? null : appendTopics(base.topics, topics)) ?? buildTopics(topics)
  const row: RosterRow = { ...base, topics: part }
  if (stored === null || JSON.stringify(stored) !== JSON.stringify(row)) writeRow(db, row)

  const byId = new Map(all.map((record) => [record.id, record]))
  const ids = new Map(Object.entries(row.ids))
  const back = new Map([...ids].map(([recordId, short]) => [short, recordId]))
  let extra = row.next
  const shortOf = (recordId: string): string => {
    const known = ids.get(recordId)
    if (known !== undefined) return known
    const short = `r${extra}`
    extra += 1
    ids.set(recordId, short)
    back.set(short, recordId)
    return short
  }
  const topicIds = new Map(Object.entries(part.ids))
  const topicBack = new Map([...topicIds].map(([recordId, short]) => [short, recordId]))
  return {
    lines: [...row.base, ...row.additions],
    shortOf,
    recordOf: (short) => back.get(short.trim()) ?? null,
    whoLine: (recordId) => {
      const record = byId.get(recordId)
      return record === undefined ? shortOf(recordId) : rosterLine(shortOf(recordId), record)
    },
    topicLines: [...part.base, ...part.additions],
    topicShortOf: (recordId) => topicIds.get(recordId) ?? null,
    topicOf: (short) => topicBack.get(short.trim()) ?? null,
    topicsLeftOut: part.dropped.length
  }
}
