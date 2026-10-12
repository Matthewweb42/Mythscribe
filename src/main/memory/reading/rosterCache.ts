import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { estimateTokens } from '@shared/ai'
import { normName } from '@shared/memory/names'
import type { StoryRecordSummary } from '@shared/memory/records'
import { settings } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'
import {
  READER_PROMPT_VERSION,
  readerRosterAddition,
  readerRosterLine
} from '../../ai/prompts/reader.v1'
import { namedInCounts } from '../nameIndexer'
import { listRecords } from '../recordStore'
import { MEMORY_ROSTER_KEY } from './roster'

/**
 * The reader's roster cache (F-16.17; plan P2a §2.5): the roster block of `reader.v1` is kept in a
 * settings row (`memoryRoster`) byte for byte across calls and sessions, so the provider's prompt
 * cache holds the rules and the roster as one stable prefix. A new record or nickname is appended
 * (`r12 +Ry`); a removal, rename, re-categorising, merge, split, *Rebuild memory* or a new reader
 * version rebuilds it (rename, merge, split and delete drop the row through `markRosterForRebuild`;
 * a nickname removed through `record:setAliases` is caught here by comparing). One line per record:
 * `r12 Mara Vell (Mara; Captain Vell) · character`. Characters, places, things, groups and terms
 * share `ROSTER_RECORD_TOKENS`: over it, the least-named records are left out (the reader may still
 * propose one as a name, which the twin gate maps back to it); 400 tokens are held for P2b's secrets
 * and threads. Short ids are never reused within a build of the row.
 */

/** The records' share of the roster's 1,600 tokens (P2b's secrets and threads hold the other 400). */
export const ROSTER_RECORD_TOKENS = 1_200

const Held = z.object({ name: z.string(), kind: z.string(), names: z.array(z.string()) })

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
  dropped: z.array(z.string())
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
    readerVersion: READER_PROMPT_VERSION,
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

/** How often each record is named across the book (certain mentions), for the cap's cut. */
function namedTotals(db: TreeDb): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of namedInCounts(db)) {
    totals.set(row.recordId, (totals.get(row.recordId) ?? 0) + row.count)
  }
  return totals
}

/**
 * The roster for a reading: the cached row, appended to or rebuilt as the records now stand, and
 * written back when it moved.
 */
export function readerRoster(db: TreeDb): ReaderRoster {
  const records = listRecords(db).filter((record) => READ_KINDS.has(record.kind))
  const stored = readRow(db)
  const current =
    stored !== null && stored.readerVersion === READER_PROMPT_VERSION
      ? appended(stored, records)
      : null
  const row = current ?? build(records, namedTotals(db))
  if (stored === null || JSON.stringify(stored) !== JSON.stringify(row)) writeRow(db, row)

  const byId = new Map(listRecords(db).map((record) => [record.id, record]))
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
  return {
    lines: [...row.base, ...row.additions],
    shortOf,
    recordOf: (short) => back.get(short.trim()) ?? null,
    whoLine: (recordId) => {
      const record = byId.get(recordId)
      return record === undefined ? shortOf(recordId) : rosterLine(shortOf(recordId), record)
    }
  }
}
