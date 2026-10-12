import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { RebuildProgress } from '@shared/memory/views'
import { settings } from '../../db/schema'
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
 */

export const MEMORY_REBUILD_KEY = 'memoryRebuild'
export const MEMORY_SPOT_KEY = 'memorySpot'
export const MEMORY_HEALTH_KEY = 'memoryHealth'
export const MEMORY_ASKED_KEY = 'memoryAsked'

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
