import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  CLAIM_MODES,
  CLAIM_PROOFS,
  CLAIM_STATES,
  CLAIM_VOICES,
  SPOT_TIERS,
  SPOT_VERDICTS
} from '@shared/memory/claims'
import { RebuildProgress } from '@shared/memory/views'
import { dismissed, settings, type ClaimRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The reader service's project settings rows (F-16.16, F-16.17, F-16.19; plan P2a §3): what must
 * outlive a close, so a reopened project picks up where it stopped. Each is read leniently (a row
 * that no longer parses reads as its default) and written whole.
 *
 * - `memoryRebuild`: the last *Rebuild memory* (its draft, scenes, how many are done, when it
 *   ended), so its queue resumes and its summary can be grouped (P2a-D25).
 * - `memorySpot`: whether a rebuild has run (1 new claim in 20 is then spot-checked), whether its
 *   50 fast and 20 strong checks are still due, and the verified claims waiting for a strong batch.
 * - `memoryHealth`: the models the author chose to keep reading with (*Keep reading anyway*,
 *   P2a-D16), per project.
 * - `memoryAsked`: the queued reads the author asked for or confirmed with a price (a priced
 *   backlog, a draft never read), spent as asked and never held back by the Cloud cap (P2a-D9).
 * - `memoryNotRight`: the claims each *Not right › Wrong value* took away, by the Dismissed row's
 *   id, so *Undo* in Dismissed brings the lines back as they were (F-16.18).
 * - `memoryNotAbout`: the record each *Not right › Not about* moved a line to, by the Dismissed
 *   row its first record got, so a later reading (a rebuild too) stores the line again for the
 *   record the author picked rather than dropping it (F-16.18).
 */

export const MEMORY_REBUILD_KEY = 'memoryRebuild'
export const MEMORY_SPOT_KEY = 'memorySpot'
export const MEMORY_HEALTH_KEY = 'memoryHealth'
export const MEMORY_ASKED_KEY = 'memoryAsked'
export const MEMORY_NOT_RIGHT_KEY = 'memoryNotRight'
export const MEMORY_NOT_ABOUT_KEY = 'memoryNotAbout'

export const SpotState = z.object({
  rebuiltAt: z.string().nullable().default(null),
  /** The rebuild's 50 fast and 20 strong checks are still to run. */
  rebuildPass: z.boolean().default(false),
  /** Verified claims picked for the strong model, sent once `SPOT_STRONG_DUE` wait. */
  strongDue: z.array(z.string()).default([])
})
export type SpotState = z.infer<typeof SpotState>

export const HealthChoices = z.object({ keep: z.array(z.string()).default([]) })
export type HealthChoices = z.infer<typeof HealthChoices>

const Asked = z.array(z.string())

function readRow<T>(db: TreeDb, key: string, schema: z.ZodType<T>, fallback: T): T {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  if (row === undefined) return fallback
  try {
    const parsed = schema.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function writeRow(db: TreeDb, key: string, value: unknown): void {
  const json = JSON.stringify(value)
  db.insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json } })
    .run()
}

export function getRebuild(db: TreeDb): RebuildProgress | null {
  return readRow(db, MEMORY_REBUILD_KEY, RebuildProgress.nullable(), null)
}

export function setRebuild(db: TreeDb, progress: RebuildProgress): void {
  writeRow(db, MEMORY_REBUILD_KEY, progress)
}

export function getSpotState(db: TreeDb): SpotState {
  return readRow(db, MEMORY_SPOT_KEY, SpotState, SpotState.parse({}))
}

export function setSpotState(db: TreeDb, state: SpotState): void {
  writeRow(db, MEMORY_SPOT_KEY, state)
}

export function getHealthChoices(db: TreeDb): HealthChoices {
  return readRow(db, MEMORY_HEALTH_KEY, HealthChoices, HealthChoices.parse({}))
}

/** *Keep reading anyway* for this model, in this project. */
export function keepReading(db: TreeDb, model: string): void {
  const choices = getHealthChoices(db)
  if (choices.keep.includes(model)) return
  writeRow(db, MEMORY_HEALTH_KEY, { keep: [...choices.keep, model] })
}

/** The node ids of queued reads the author asked for. */
export function getAsked(db: TreeDb): Set<string> {
  return new Set(readRow(db, MEMORY_ASKED_KEY, Asked, []))
}

export function setAsked(db: TreeDb, nodeIds: ReadonlySet<string>): void {
  writeRow(db, MEMORY_ASKED_KEY, [...nodeIds].sort())
}

/** A claim row as a *Not right* keeps it (the `claim` table's columns). */
const StashedClaim = z.object({
  id: z.string(),
  nodeId: z.string(),
  draftId: z.string(),
  readingId: z.string().nullable(),
  recordId: z.string().nullable(),
  pending: z.string().nullable(),
  subjectText: z.string().nullable(),
  slot: z.string(),
  value: z.string(),
  valueKey: z.string(),
  objectId: z.string().nullable(),
  how: z.string().nullable(),
  fromId: z.string().nullable(),
  voice: z.enum(CLAIM_VOICES),
  speakerId: z.string().nullable(),
  mode: z.enum(CLAIM_MODES),
  quote: z.string(),
  para: z.number().int(),
  anchor: z.string(),
  proof: z.enum(CLAIM_PROOFS),
  change: z.boolean(),
  state: z.enum(CLAIM_STATES),
  spot: z.enum(SPOT_VERDICTS).nullable(),
  spotTier: z.enum(SPOT_TIERS).nullable(),
  spotAt: z.string().nullable(),
  created: z.string(),
  proved: z.string()
}) satisfies z.ZodType<ClaimRow>

/** The claim rows a *Not right* took away, as stored, by the Dismissed row's id. */
const NotRightStash = z.record(z.string(), z.array(StashedClaim))
export type NotRightStash = Record<string, ClaimRow[]>

export function getNotRightStash(db: TreeDb): NotRightStash {
  return readRow(db, MEMORY_NOT_RIGHT_KEY, NotRightStash, {})
}

export function setNotRightStash(db: TreeDb, stash: NotRightStash): void {
  writeRow(db, MEMORY_NOT_RIGHT_KEY, stash)
}

/** Where each *Not about* moved its line: the Dismissed row's id to the record picked. */
const NotAboutMoves = z.record(z.string(), z.string())
export type NotAboutMoves = Record<string, string>

export function getNotAboutMoves(db: TreeDb): NotAboutMoves {
  return readRow(db, MEMORY_NOT_ABOUT_KEY, NotAboutMoves, {})
}

export function setNotAboutMoves(db: TreeDb, moves: NotAboutMoves): void {
  writeRow(db, MEMORY_NOT_ABOUT_KEY, moves)
}

/**
 * The `notRight` keys of the lines *Not about* moved (their rows still dismissed), each to the
 * record it went to: what reconciliation stores a fresh item for instead of dropping it.
 */
export function notAboutMovedTo(db: TreeDb): Map<string, string> {
  const moves = getNotAboutMoves(db)
  const ids = Object.keys(moves)
  if (ids.length === 0) return new Map()
  const rows = db
    .select({ id: dismissed.id, key: dismissed.key })
    .from(dismissed)
    .where(inArray(dismissed.id, ids))
    .all()
  return new Map(
    rows.flatMap((row) => {
      const to = moves[row.id]
      return to === undefined ? [] : [[row.key, to] as const]
    })
  )
}
