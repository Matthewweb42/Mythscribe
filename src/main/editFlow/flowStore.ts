import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { findQuote } from '@shared/critique'
import {
  EditFlowNoteEdits,
  EditFlowSpec,
  scopeKey,
  type EditFlowCategory,
  type EditFlowDetail,
  type EditFlowIssue,
  type EditFlowNoteEdit,
  type EditFlowRun
} from '@shared/editFlow'
import type { EditChange } from '@shared/editPass'
import { editChange, editPass, type EditPassRow } from '../db/schema'
import { countsFor, evictPasses, passNodeIds } from '../editPass/editPassStore'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * The edit flow's kept results (notes redesign phase 2, migration 0042): a run is an `edit_pass`
 * row with `flow` set and its issues are `edit_change` rows with `flow_category` set, so a fix is
 * a pending tracked change the editor draws, accepts and settles through the edit passes' own
 * channels. The latest run of each scope stays: starting one removes the finished runs of the same
 * scope (and their issues, by cascade). The runner (`run.ts`) writes, the handlers read.
 */

/** What the `flow` column holds: the spec, the scope's title, the requests answered of all. */
const FlowColumn = z.object({
  spec: EditFlowSpec,
  scopeTitle: z.string(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Phase 3: an automatic notes update; absent on a run kept before it (manual). */
  automatic: z.boolean().default(false)
})
type FlowColumn = z.infer<typeof FlowColumn>

/** The row's flow state, or null for an edit pass (or an unreadable value). */
export function readFlow(row: Pick<EditPassRow, 'flow'>): FlowColumn | null {
  if (row.flow === null) return null
  try {
    const parsed = FlowColumn.safeParse(JSON.parse(row.flow))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function readNoteEdits(value: string): EditFlowNoteEdit[] {
  try {
    const parsed = EditFlowNoteEdits.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export interface CreateFlowRunInput {
  spec: EditFlowSpec
  scopeTitle: string
  /** The scope's scenes in reading order. */
  nodeIds: readonly string[]
  /** The requests the run will send. */
  total: number
  /** An automatic notes update (phase 3), kept apart from the author's own runs. */
  automatic?: boolean
  now?: string
}

/**
 * Inserts a running flow run. The finished runs of the same scope go first (the latest per scope
 * is kept; an automatic run's scope is its own, so it never replaces the author's run and hers
 * never replaces it), then the oldest passes beyond the edit passes' cap.
 */
export function createFlowRun(db: TreeDb, input: CreateFlowRunInput): EditPassRow {
  const automatic = input.automatic ?? false
  const key = scopeKey(input.spec.scope, automatic)
  for (const row of flowRows(db)) {
    const flow = readFlow(row)
    if (
      flow !== null &&
      row.status !== 'running' &&
      scopeKey(flow.spec.scope, flow.automatic) === key
    ) {
      db.delete(editPass).where(eq(editPass.id, row.id)).run()
    }
  }
  const id = randomUUID()
  const flow: FlowColumn = {
    spec: input.spec,
    scopeTitle: input.scopeTitle,
    done: 0,
    total: input.total,
    automatic
  }
  db.insert(editPass)
    .values({
      id,
      type: 'custom',
      instruction: null,
      status: 'running',
      nodeIds: JSON.stringify(input.nodeIds),
      createdAt: input.now ?? new Date().toISOString(),
      flow: JSON.stringify(flow)
    })
    .run()
  evictPasses(db)
  return requireFlowRow(db, id)
}

/** Every flow run, newest first. */
export function flowRows(db: TreeDb): EditPassRow[] {
  return db
    .select()
    .from(editPass)
    .where(isNotNull(editPass.flow))
    .orderBy(desc(editPass.createdAt), desc(sql`rowid`))
    .all()
}

export function requireFlowRow(db: TreeDb, id: string): EditPassRow {
  const row = db.select().from(editPass).where(eq(editPass.id, id)).get()
  if (row === undefined || readFlow(row) === null) {
    throw new AppError('NOT_FOUND', 'That edit run no longer exists', { id })
  }
  return row
}

/** Writes how many of the run's requests have been answered. */
export function setFlowDone(db: TreeDb, id: string, done: number): void {
  const row = requireFlowRow(db, id)
  const flow = readFlow(row)
  if (flow === null) return
  db.update(editPass)
    .set({ flow: JSON.stringify({ ...flow, done }) })
    .where(eq(editPass.id, id))
    .run()
}

/** Adds to the run's developmental overview (a slice's own overview, headed in a longer run). */
export function appendOverview(db: TreeDb, id: string, text: string): void {
  const row = requireFlowRow(db, id)
  const next = row.overview === null ? text : `${row.overview}\n\n${text}`
  db.update(editPass).set({ overview: next }).where(eq(editPass.id, id)).run()
}

/** Adds the note edits Update notes applied. */
export function appendNoteEdits(
  db: TreeDb,
  id: string,
  edits: readonly EditFlowNoteEdit[]
): void {
  if (edits.length === 0) return
  const row = requireFlowRow(db, id)
  const next = [...readNoteEdits(row.noteEdits), ...edits]
  db.update(editPass)
    .set({ noteEdits: JSON.stringify(next) })
    .where(eq(editPass.id, id))
    .run()
}

/** Marks one note edit undone (the renderer ran its Undo); false when there is no such edit. */
export function markNoteEditUndone(db: TreeDb, id: string, index: number): boolean {
  const row = requireFlowRow(db, id)
  const edits = readNoteEdits(row.noteEdits)
  const edit = edits[index]
  if (edit === undefined || edit.undone) return false
  edits[index] = { ...edit, undone: true }
  db.update(editPass)
    .set({ noteEdits: JSON.stringify(edits) })
    .where(eq(editPass.id, id))
    .run()
  return true
}

export type IssueInput = Omit<EditChange, 'id' | 'status'> & { flowCategory: EditFlowCategory }

/** Inserts a request's issues as `pending`. */
export function insertIssues(db: TreeDb, issues: readonly IssueInput[]): void {
  if (issues.length === 0) return
  db.insert(editChange)
    .values(issues.map((issue) => ({ ...issue, id: randomUUID(), status: 'pending' as const })))
    .run()
}

/** The run as the panel lists it. */
export function flowRunOf(db: TreeDb, row: EditPassRow): EditFlowRun {
  const flow = readFlow(row)
  if (flow === null) throw new AppError('NOT_FOUND', 'That edit run no longer exists', { id: row.id })
  return {
    id: row.id,
    spec: flow.spec,
    scopeTitle: flow.scopeTitle,
    automatic: flow.automatic,
    status: row.status,
    done: flow.done,
    total: flow.total,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    counts: countsFor(db, row.id),
    dropped: row.dropped,
    error: row.error,
    overview: row.overview,
    noteEdits: readNoteEdits(row.noteEdits),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt
  }
}

/** Every flow run, newest first. */
export function listFlowRuns(db: TreeDb): EditFlowRun[] {
  return flowRows(db).map((row) => flowRunOf(db, row))
}

/**
 * A run with its issues in book order (by the scope's reading order, then place in the scene) and
 * the titles of its scenes. A pending issue whose passage the author's edits have since changed
 * reads `textChanged` (`sceneText` gives a scene's text as it stands now; null when it is gone).
 */
export function flowDetail(
  db: TreeDb,
  id: string,
  sceneText: (nodeId: string) => string | null,
  titleOf: (nodeId: string) => string
): EditFlowDetail {
  const row = requireFlowRow(db, id)
  const run = flowRunOf(db, row)
  const place = new Map(passNodeIds(row).map((nodeId, index) => [nodeId, index]))
  const rows = db
    .select()
    .from(editChange)
    .where(and(eq(editChange.passId, id), isNotNull(editChange.flowCategory)))
    .orderBy(asc(sql`rowid`))
    .all()
  const texts = new Map<string, string | null>()
  const textOf = (nodeId: string): string | null => {
    if (!texts.has(nodeId)) texts.set(nodeId, sceneText(nodeId))
    return texts.get(nodeId) ?? null
  }
  const issues: EditFlowIssue[] = rows.flatMap((change) => {
    if (change.flowCategory === null) return []
    const text = change.status === 'pending' ? textOf(change.nodeId) : null
    return [
      {
        id: change.id,
        passId: change.passId,
        nodeId: change.nodeId,
        kind: change.kind,
        position: change.position,
        original: change.original,
        replacement: change.replacement,
        rationale: change.rationale,
        category: change.category,
        flagged: change.flagged,
        violation: change.violation,
        status: change.status,
        proposalId: change.proposalId,
        flowCategory: change.flowCategory,
        textChanged: change.status === 'pending' && (text === null || !findQuote(text, change.original))
      }
    ]
  })
  issues.sort(
    (a, b) =>
      (place.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) -
        (place.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER) || a.position - b.position
  )
  const titles: Record<string, string> = {}
  for (const nodeId of new Set(issues.map((issue) => issue.nodeId))) titles[nodeId] = titleOf(nodeId)
  return { run, issues, titles }
}
