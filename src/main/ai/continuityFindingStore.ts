import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  continuityDedupeKey,
  type ContinuityFinding,
  type ContinuityOrigin,
  type ContinuityRef
} from '@shared/continuity'
import {
  continuityFinding,
  type ContinuityFindingInsert,
  type ContinuityFindingRow
} from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'

/**
 * The `continuity_finding` rows (F-13.4): the contradictions the consistency checker found, one
 * row per passage and reference. Derived data (author-control rule 1): nothing here is in the
 * manuscript, a fix reaches the text only through its proposal, and the author removes a row
 * with one click. `open` rows are what the panel lists; a `dismissed` row is a tombstone whose
 * `dedupe_key` keeps the same contradiction from being raised again for that scene; an `applied`
 * row records that the fix went in. The run logic lives in `continuity.ts`; this file only
 * reads and writes rows.
 */

/** One finding as a run hands it over: located, scored, and tied to the reference it contradicts. */
export interface FindingInput {
  ref: ContinuityRef
  quote: string
  why: string
  fix: string | null
  flagged: boolean
  violation: string | null
}

function rowToFinding(row: ContinuityFindingRow): ContinuityFinding {
  return {
    id: row.id,
    nodeId: row.nodeId,
    ref: {
      kind: row.refKind,
      entityId: row.entityId,
      entityName: row.entityName,
      entityKind: row.entityKind,
      attribute: row.attribute,
      label: row.refLabel,
      value: row.refValue,
      nodeId: row.refNodeId,
      quote: row.refQuote
    },
    quote: row.quote,
    why: row.why,
    fix: row.fix,
    flagged: row.flagged,
    violation: row.violation,
    status: row.status,
    origin: row.origin,
    proposalId: row.proposalId,
    createdAt: row.createdAt
  }
}

/** Oldest first; the rowid keeps the findings of one run in the order the run listed them. */
const oldestFirst = [asc(continuityFinding.createdAt), sql`rowid`] as const

/**
 * Every open finding of the project, in reading order of their scenes (a scene outside the
 * manuscript sorts after the rest), oldest first within a scene: what `continuity:list` answers.
 */
export function listOpenFindings(db: TreeDb): ContinuityFinding[] {
  const position = new Map(manuscriptDocuments(db).map((row, at) => [row.id, at]))
  const at = (nodeId: string): number => position.get(nodeId) ?? position.size
  return db
    .select()
    .from(continuityFinding)
    .where(eq(continuityFinding.status, 'open'))
    .orderBy(...oldestFirst)
    .all()
    .map((row, input) => ({ finding: rowToFinding(row), input }))
    .sort((a, b) => at(a.finding.nodeId) - at(b.finding.nodeId) || a.input - b.input)
    .map(({ finding }) => finding)
}

/** The open findings of one scene, oldest first. */
export function openFindingsForNode(db: TreeDb, nodeId: string): ContinuityFinding[] {
  return db
    .select()
    .from(continuityFinding)
    .where(and(eq(continuityFinding.nodeId, nodeId), eq(continuityFinding.status, 'open')))
    .orderBy(...oldestFirst)
    .all()
    .map(rowToFinding)
}

/**
 * The dedupe keys the author dismissed for one scene ("changed in the story"): a reference
 * whose key is here is not sent again for that scene, and a finding against it is dropped.
 */
export function dismissedKeys(db: TreeDb, nodeId: string): Set<string> {
  const rows = db
    .select({ key: continuityFinding.dedupeKey })
    .from(continuityFinding)
    .where(and(eq(continuityFinding.nodeId, nodeId), eq(continuityFinding.status, 'dismissed')))
    .all()
  return new Set(rows.map((row) => row.key))
}

/** Stores the findings of one run as `open` rows, in the order given, and answers them as stored. */
export function insertFindings(
  db: TreeDb,
  nodeId: string,
  findings: readonly FindingInput[],
  stamp: { origin: ContinuityOrigin; proposalId: string | null; createdAt: string }
): ContinuityFinding[] {
  if (findings.length === 0) return []
  const rows: ContinuityFindingInsert[] = findings.map((finding) => ({
    id: randomUUID(),
    nodeId,
    refKind: finding.ref.kind,
    entityId: finding.ref.entityId,
    entityName: finding.ref.entityName,
    entityKind: finding.ref.entityKind,
    attribute: finding.ref.attribute,
    refLabel: finding.ref.label,
    refValue: finding.ref.value,
    refNodeId: finding.ref.nodeId,
    refQuote: finding.ref.quote,
    quote: finding.quote,
    why: finding.why,
    fix: finding.fix,
    flagged: finding.flagged,
    violation: finding.violation,
    status: 'open',
    origin: stamp.origin,
    dedupeKey: continuityDedupeKey(nodeId, finding.ref),
    proposalId: stamp.proposalId,
    createdAt: stamp.createdAt
  }))
  return db.insert(continuityFinding).values(rows).returning().all().map(rowToFinding)
}

/** Removes findings by id; an id that is gone already is a silent no-op. */
export function deleteFindings(db: TreeDb, ids: readonly string[]): void {
  if (ids.length === 0) return
  db.delete(continuityFinding)
    .where(inArray(continuityFinding.id, [...ids]))
    .run()
}

/**
 * Settles one open finding (`dismissed` or `applied`) and answers it as stored. NOT_FOUND for an
 * unknown or already settled id: a later run replaced the finding, or its scene or entity was deleted, since the
 * panel listed it.
 */
export function settleFinding(
  db: TreeDb,
  id: string,
  status: 'dismissed' | 'applied'
): ContinuityFinding {
  const updated = db
    .update(continuityFinding)
    .set({ status })
    .where(and(eq(continuityFinding.id, id), eq(continuityFinding.status, 'open')))
    .returning()
    .get()
  // Only an open finding is settled: a second window settling it again must neither lift a
  // dismissal's tombstone nor settle the proposal twice.
  if (updated === undefined) throw new AppError('NOT_FOUND', 'Finding not found', { id })
  return rowToFinding(updated)
}

/** The status of every finding still stored for one proposal: what its settlement is decided from. */
export function proposalFindingStatuses(
  db: TreeDb,
  proposalId: string
): ContinuityFinding['status'][] {
  return db
    .select({ status: continuityFinding.status })
    .from(continuityFinding)
    .where(eq(continuityFinding.proposalId, proposalId))
    .all()
    .map((row) => row.status)
}
