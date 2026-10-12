import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { HEALTH_WINDOW } from '@shared/memory/health'
import { ParaRange, type Reading, type ReadingYields } from '@shared/memory/claims'
import { reading, type ReadingRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * Readings of story memory v2 (F-16.17; P2a-D1): one row per reading of one scene, all its pages,
 * with what it cost (reader and verify together) and what it yielded. The health gate reads a
 * model's newest rows; ⓘ reads one.
 */

const Paras = z.array(ParaRange)
const Rejections = z.record(z.string(), z.number().int().nonnegative())

function parse<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function toReading(row: ReadingRow): Reading {
  return {
    id: row.id,
    nodeId: row.nodeId,
    draftId: row.draftId,
    purpose: row.purpose,
    pages: row.pages,
    paras: parse(row.paras, Paras, []),
    promptVersion: row.promptVersion,
    verifyVersion: row.verifyVersion,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    reasoningTokens: row.reasoningTokens,
    costUsd: row.costUsd,
    cloud: row.cloud,
    finishReason: row.finishReason,
    yields: {
      items: row.items,
      quotesFound: row.quotesFound,
      literal: row.literal,
      verifySent: row.verifySent,
      verified: row.verified,
      rejected: row.rejected,
      rejections: parse(row.rejections, Rejections, {}),
      cut: row.cut
    },
    created: row.created
  }
}

export type NewReading = Omit<Reading, 'id' | 'created'>

/** Stores a reading with its yields; answers its id. */
export function insertReading(db: TreeDb, next: NewReading, now: Date): string {
  const id = randomUUID()
  const yields: ReadingYields = next.yields
  db.insert(reading)
    .values({
      id,
      nodeId: next.nodeId,
      draftId: next.draftId,
      purpose: next.purpose,
      pages: next.pages,
      paras: JSON.stringify(next.paras),
      promptVersion: next.promptVersion,
      verifyVersion: next.verifyVersion,
      model: next.model,
      tokensIn: next.tokensIn,
      tokensOut: next.tokensOut,
      reasoningTokens: next.reasoningTokens,
      costUsd: next.costUsd,
      cloud: next.cloud,
      finishReason: next.finishReason,
      items: yields.items,
      quotesFound: yields.quotesFound,
      literal: yields.literal,
      verifySent: yields.verifySent,
      verified: yields.verified,
      rejected: yields.rejected,
      rejections: JSON.stringify(yields.rejections),
      cut: yields.cut,
      created: now.toISOString()
    })
    .run()
  return id
}

export function getReading(db: TreeDb, id: string): Reading | null {
  const row = db.select().from(reading).where(eq(reading.id, id)).get()
  return row === undefined ? null : toReading(row)
}

/** A scene's newest reading in a draft. */
export function lastReading(db: TreeDb, nodeId: string, draftId: string): Reading | null {
  const row = db
    .select()
    .from(reading)
    .where(and(eq(reading.nodeId, nodeId), eq(reading.draftId, draftId)))
    .orderBy(desc(reading.created), sql`rowid DESC`)
    .get()
  return row === undefined ? null : toReading(row)
}

/** A model's newest readings, newest first (the health gate's window). */
export function recentReadings(db: TreeDb, model: string, limit = HEALTH_WINDOW): Reading[] {
  return db
    .select()
    .from(reading)
    .where(eq(reading.model, model))
    .orderBy(desc(reading.created), sql`rowid DESC`)
    .limit(limit)
    .all()
    .map(toReading)
}
