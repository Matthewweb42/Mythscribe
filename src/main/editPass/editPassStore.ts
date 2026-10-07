import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import {
  EDIT_PASS_PRESETS_KEY,
  EDIT_PASS_RETENTION_MAX,
  EditPassPresets,
  type EditChange,
  type EditChangeStatus,
  type EditPassDetail,
  type EditPassStatus,
  type EditPassSummary,
  type EditPassType
} from '@shared/editPass'
import { z } from 'zod'
import { editChange, editPass, node, settings, type EditPassRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * The edit-pass rows (F-14.15): one `edit_pass` per pass and its `edit_change` rows. The runner
 * (`src/main/ai/editPass.ts`) writes them scene by scene; the renderer reads them through the
 * `editPass:*` channels and settles changes as the author accepts or rejects them. Nothing here
 * touches the manuscript.
 */

const NodeIds = z.array(z.string())

/** A JSON list of node ids from a column; an unreadable value reads as none. */
function readIds(value: string): string[] {
  try {
    const parsed = NodeIds.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export interface CreatePassInput {
  type: EditPassType
  instruction: string | null
  nodeIds: readonly string[]
  /** ISO timestamp; defaults to now. */
  now?: string
}

/** Inserts a running pass over `nodeIds` and evicts the oldest finished passes beyond the cap. */
export function createPass(db: TreeDb, input: CreatePassInput): EditPassRow {
  const id = randomUUID()
  db.insert(editPass)
    .values({
      id,
      type: input.type,
      instruction: input.instruction,
      status: 'running',
      nodeIds: JSON.stringify(input.nodeIds),
      createdAt: input.now ?? new Date().toISOString()
    })
    .run()
  evictPasses(db)
  return requirePass(db, id)
}

export function getPassRow(db: TreeDb, id: string): EditPassRow | undefined {
  return db.select().from(editPass).where(eq(editPass.id, id)).get()
}

export function requirePass(db: TreeDb, id: string): EditPassRow {
  const row = getPassRow(db, id)
  if (!row) throw new AppError('NOT_FOUND', 'That edit pass no longer exists', { id })
  return row
}

export interface PassProgress {
  doneNodeIds?: readonly string[]
  model?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  dropped?: number
  status?: EditPassStatus
  error?: string | null
  finishedAt?: string | null
}

/** Writes the given fields of a pass. */
export function updatePass(db: TreeDb, id: string, patch: PassProgress): void {
  const { doneNodeIds, ...rest } = patch
  db.update(editPass)
    .set({
      ...rest,
      ...(doneNodeIds === undefined ? {} : { doneNodeIds: JSON.stringify(doneNodeIds) })
    })
    .where(eq(editPass.id, id))
    .run()
}

/** The scenes a pass has finished. */
export function doneNodeIds(row: EditPassRow): string[] {
  return readIds(row.doneNodeIds)
}

/** The scenes a pass covers, in reading order. */
export function passNodeIds(row: EditPassRow): string[] {
  return readIds(row.nodeIds)
}

/**
 * Passes left `running` by a crash or a quit are `cancelled` when the project opens again: their
 * finished scenes' changes stay, and Resume picks the rest up. Returns how many there were.
 */
export function interruptRunningPasses(db: TreeDb): number {
  return db
    .update(editPass)
    .set({ status: 'cancelled', error: 'Stopped when MythScribe closed.' })
    .where(eq(editPass.status, 'running'))
    .run().changes
}

/** Keeps the newest `max` passes; a running pass is never evicted. */
export function evictPasses(db: TreeDb, max = EDIT_PASS_RETENTION_MAX): number {
  const keep = db
    .select({ id: editPass.id })
    .from(editPass)
    .orderBy(desc(editPass.createdAt), desc(sql`rowid`))
    .limit(max)
    .all()
    .map((row) => row.id)
  if (keep.length < max) return 0
  return db
    .delete(editPass)
    .where(and(ne(editPass.status, 'running'), notInArray(editPass.id, keep)))
    .run().changes
}

export function deletePass(db: TreeDb, id: string): void {
  const row = requirePass(db, id)
  if (row.status === 'running') {
    throw new AppError('VALIDATION', 'Stop the pass before deleting it', { id })
  }
  db.delete(editPass).where(eq(editPass.id, id)).run()
}

export type ChangeInput = Omit<EditChange, 'id' | 'status'>

/** Inserts a scene's changes or notes as `pending`. */
export function insertChanges(db: TreeDb, changes: readonly ChangeInput[]): void {
  if (changes.length === 0) return
  db.insert(editChange)
    .values(changes.map((change) => ({ ...change, id: randomUUID(), status: 'pending' as const })))
    .run()
}

/** A pass's changes or notes, in reading order of the pass's scenes, then position. */
export function listChanges(
  db: TreeDb,
  filter: { passId?: string; nodeId?: string }
): EditChange[] {
  const where = and(
    filter.passId === undefined ? undefined : eq(editChange.passId, filter.passId),
    filter.nodeId === undefined ? undefined : eq(editChange.nodeId, filter.nodeId)
  )
  return db
    .select()
    .from(editChange)
    .where(where)
    .orderBy(asc(editChange.passId), asc(sql`rowid`))
    .all()
    .map((row) => ({
      id: row.id,
      passId: row.passId,
      nodeId: row.nodeId,
      kind: row.kind,
      position: row.position,
      original: row.original,
      replacement: row.replacement,
      rationale: row.rationale,
      category: row.category,
      flagged: row.flagged,
      violation: row.violation,
      status: row.status,
      proposalId: row.proposalId
    }))
}

/** The pending tracked changes of a scene across every finished or stopped pass, for the editor. */
export function pendingChangesFor(db: TreeDb, nodeId: string): EditChange[] {
  return listChanges(db, { nodeId }).filter(
    (change) => change.kind === 'change' && change.status === 'pending'
  )
}

/**
 * Settles changes: only a `pending` row moves (so a second click, or a stale window, changes
 * nothing). Returns the rows that moved, with their pass and scene.
 */
export function settleChanges(
  db: TreeDb,
  ids: readonly string[],
  status: Exclude<EditChangeStatus, 'pending'>
): EditChange[] {
  if (ids.length === 0) return []
  const moving = db
    .select({ id: editChange.id })
    .from(editChange)
    .where(and(inArray(editChange.id, [...ids]), eq(editChange.status, 'pending')))
    .all()
    .map((row) => row.id)
  if (moving.length === 0) return []
  db.update(editChange).set({ status }).where(inArray(editChange.id, moving)).run()
  return db
    .select()
    .from(editChange)
    .where(inArray(editChange.id, moving))
    .all()
    .map((row) => ({ ...row }))
}

/** Changes of a proposal by status, so the proposal settles once none is pending. */
export function proposalChangeCounts(
  db: TreeDb,
  proposalId: string
): Record<EditChangeStatus, number> {
  const counts: Record<EditChangeStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    stale: 0
  }
  const rows = db
    .select({ status: editChange.status, n: sql<number>`count(*)` })
    .from(editChange)
    .where(eq(editChange.proposalId, proposalId))
    .groupBy(editChange.status)
    .all()
  for (const row of rows) counts[row.status] = row.n
  return counts
}

function countsFor(db: TreeDb, passId: string): EditPassSummary['counts'] {
  const counts = { pending: 0, accepted: 0, rejected: 0, stale: 0 }
  const rows = db
    .select({ status: editChange.status, n: sql<number>`count(*)` })
    .from(editChange)
    .where(eq(editChange.passId, passId))
    .groupBy(editChange.status)
    .all()
  for (const row of rows) counts[row.status] = row.n
  return counts
}

/** The pass as the renderer reads it; `currentNodeId` is the runner's, passed in. */
export function toSummary(
  db: TreeDb,
  row: EditPassRow,
  currentNodeId: string | null = null
): EditPassSummary {
  return {
    id: row.id,
    type: row.type,
    instruction: row.instruction,
    status: row.status,
    nodeIds: passNodeIds(row),
    doneNodeIds: doneNodeIds(row),
    currentNodeId: row.status === 'running' ? currentNodeId : null,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    counts: countsFor(db, row.id),
    dropped: row.dropped,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt
  }
}

/** Every pass, newest first. */
export function listPassRows(db: TreeDb): EditPassRow[] {
  return db
    .select()
    .from(editPass)
    .orderBy(desc(editPass.createdAt), desc(sql`rowid`))
    .all()
}

/** One pass with its changes and the titles of its scenes, for the report. */
export function passDetail(
  db: TreeDb,
  id: string,
  currentNodeId: string | null = null
): EditPassDetail {
  const row = requirePass(db, id)
  const nodeIds = passNodeIds(row)
  const titles: Record<string, string> = {}
  if (nodeIds.length > 0) {
    for (const entry of db
      .select({ id: node.id, title: node.title })
      .from(node)
      .where(inArray(node.id, nodeIds))
      .all()) {
      titles[entry.id] = entry.title
    }
  }
  return {
    pass: toSummary(db, row, currentNodeId),
    changes: listChanges(db, { passId: id }),
    titles
  }
}

/** The author's saved custom presets; a missing or unreadable row is none. */
export function getPresets(db: TreeDb): EditPassPresets {
  const row = db.select().from(settings).where(eq(settings.key, EDIT_PASS_PRESETS_KEY)).get()
  if (!row) return []
  try {
    const parsed = EditPassPresets.safeParse(JSON.parse(row.value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** Replaces the saved presets and answers what was stored. */
export function setPresets(db: TreeDb, presets: EditPassPresets): EditPassPresets {
  const stored = EditPassPresets.parse(presets)
  const value = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: EDIT_PASS_PRESETS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
  return stored
}
