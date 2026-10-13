import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { Candidate } from '@shared/memory/candidates'
import {
  type Finding,
  FindingExtra,
  FindingSide,
  findingState,
  type FindingCloseReason,
  type FindingState,
  type JudgeVerdict
} from '@shared/memory/findings'
import type { InvariantFinding } from '@shared/memory/invariants'
import { claim, finding, type FindingRow } from '../../db/schema'
import type { TreeDb } from '../../tree/treeStore'

/**
 * The `finding` rows (F-16.27; plan P4 §1.4): one per candidate and draft, by its lifecycle key.
 * Derived index data (AI rule 1's exception): references into the book and the notes, verdicts,
 * state and cost, never the author's text. Only the active draft's rows are live.
 */

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** A row as a `Finding`; null for a row whose sides no longer parse (it is closed on the next pass). */
export function toFinding(row: FindingRow): Finding | null {
  const a = FindingSide.safeParse(parseJson(row.a))
  const b = FindingSide.safeParse(parseJson(row.b))
  if (!a.success || !b.success) return null
  const extra = row.extra === null ? null : FindingExtra.safeParse(parseJson(row.extra))
  return {
    id: row.id,
    draftId: row.draftId,
    rule: row.rule,
    variant: row.variant,
    recordId: row.recordId,
    slot: row.slot,
    key: row.key,
    npKey: row.npKey,
    a: a.data,
    b: b.data,
    extra: !extra?.success ? null : extra.data,
    verdictAb: row.verdictAb,
    verdictBa: row.verdictBa,
    why: row.why,
    confirm: row.confirm,
    confirmWhy: row.confirmWhy,
    state: row.state,
    costUsd: row.costUsd,
    shownAt: row.shownAt,
    created: row.created,
    judgedAt: row.judgedAt,
    confirmedAt: row.confirmedAt
  }
}

/** A draft's finding rows, optionally only in some states. */
export function findingRows(
  db: TreeDb,
  draftId: string,
  states?: readonly FindingState[]
): FindingRow[] {
  return db
    .select()
    .from(finding)
    .where(
      states === undefined
        ? eq(finding.draftId, draftId)
        : and(eq(finding.draftId, draftId), inArray(finding.state, [...states]))
    )
    .all()
}

/** A draft's findings, optionally only in some states. */
export function findingsOf(
  db: TreeDb,
  draftId: string,
  states?: readonly FindingState[]
): Finding[] {
  return findingRows(db, draftId, states).flatMap((row) => {
    const parsed = toFinding(row)
    return parsed === null ? [] : [parsed]
  })
}

/** Both orders' verdicts, as the cache remembers them for a candidate (slice 2 renders the pair). */
export interface PairVerdicts {
  ab: JudgeVerdict | null
  ba: JudgeVerdict | null
  why: string | null
}

/** What an upsert did. */
export interface UpsertResult {
  /** Ids of findings that are open now and were not before. */
  opened: string[]
  /** Rows written (inserted or changed). */
  written: number
}

/**
 * Writes the candidates as findings of `draftId`, by key: a new key is inserted, its verdicts taken
 * from the cache for both orders when `cached` knows them (at no cost), else `unjudged`; a kept key
 * keeps its verdicts (a row still missing one asks the cache again), takes the candidate's sides
 * (a re-read claim's new id) and its held or hidden state. Nothing is written for a row unchanged.
 */
export function upsertFindings(
  db: TreeDb,
  draftId: string,
  candidates: readonly Candidate[],
  now: Date,
  cached: (candidate: Candidate) => PairVerdicts | null = () => null
): UpsertResult {
  const result: UpsertResult = { opened: [], written: 0 }
  if (candidates.length === 0) return result
  const existing = new Map(findingRows(db, draftId).map((row) => [row.key, row]))
  db.transaction((tx) => {
    for (const each of candidates) {
      const row = existing.get(each.key)
      const a = JSON.stringify(each.a)
      const b = JSON.stringify(each.b)
      const extra = each.extra === null ? null : JSON.stringify(each.extra)
      let verdictAb = row?.verdictAb ?? null
      let verdictBa = row?.verdictBa ?? null
      let why = row?.why ?? null
      let judgedAt = row?.judgedAt ?? null
      if (verdictAb === null || verdictBa === null) {
        const known = cached(each)
        if (known !== null && (known.ab !== null || known.ba !== null)) {
          verdictAb = verdictAb ?? known.ab
          verdictBa = verdictBa ?? known.ba
          why = why ?? known.why
          judgedAt = now.toISOString()
        }
      }
      const state = findingState({
        held: each.held,
        hidden: each.hidden,
        verdictAb,
        verdictBa,
        confirm: row?.confirm ?? null
      })
      if (row === undefined) {
        const id = randomUUID()
        tx.insert(finding)
          .values({
            id,
            draftId,
            rule: each.rule,
            variant: each.variant,
            recordId: each.recordId,
            slot: each.slot,
            key: each.key,
            npKey: each.npKey,
            a,
            b,
            extra,
            verdictAb,
            verdictBa,
            why,
            state,
            created: now.toISOString(),
            judgedAt
          })
          .run()
        result.written += 1
        if (state === 'open') result.opened.push(id)
        continue
      }
      const same =
        row.a === a &&
        row.b === b &&
        row.extra === extra &&
        row.state === state &&
        row.verdictAb === verdictAb &&
        row.verdictBa === verdictBa
      if (same) continue
      tx.update(finding)
        .set({ a, b, extra, state, verdictAb, verdictBa, why, judgedAt })
        .where(eq(finding.id, row.id))
        .run()
      result.written += 1
      if (state === 'open' && row.state !== 'open') result.opened.push(row.id)
    }
  })
  return result
}

/** A finding that closed, and why (slice 5's precision log reads `shownAt`). */
export interface ClosedFinding {
  finding: Finding
  reason: FindingCloseReason
}

/** Closes (deletes) findings of `draftId` by key, each with its reason. */
export function closeFindings(
  db: TreeDb,
  draftId: string,
  closing: readonly { key: string; reason: FindingCloseReason }[]
): ClosedFinding[] {
  if (closing.length === 0) return []
  const reasons = new Map(closing.map((each) => [each.key, each.reason]))
  const rows = db
    .select()
    .from(finding)
    .where(and(eq(finding.draftId, draftId), inArray(finding.key, [...reasons.keys()])))
    .all()
  if (rows.length === 0) return []
  db.delete(finding)
    .where(
      inArray(
        finding.id,
        rows.map((row) => row.id)
      )
    )
    .run()
  return rows.flatMap((row) => {
    const parsed = toFinding(row)
    return parsed === null ? [] : [{ finding: parsed, reason: reasons.get(row.key) ?? 'gone' }]
  })
}

/** Stores a finding's verdicts in both orders, the judge's reason, its cost share and its state. */
export function setVerdicts(
  db: TreeDb,
  id: string,
  input: {
    ab: JudgeVerdict | null
    ba: JudgeVerdict | null
    why: string | null
    costUsd: number
    now: Date
  }
): void {
  const row = db.select().from(finding).where(eq(finding.id, id)).get()
  if (row === undefined) return
  db.update(finding)
    .set({
      verdictAb: input.ab,
      verdictBa: input.ba,
      why: input.why,
      costUsd: row.costUsd + input.costUsd,
      judgedAt: input.now.toISOString(),
      state:
        row.state === 'held' || row.state === 'hidden'
          ? row.state
          : findingState({
              held: false,
              hidden: false,
              verdictAb: input.ab,
              verdictBa: input.ba,
              confirm: row.confirm
            })
    })
    .where(eq(finding.id, id))
    .run()
}

/** Stores the stronger check's verdict on an open finding (*Check the book*). */
export function setConfirm(
  db: TreeDb,
  id: string,
  input: { confirm: JudgeVerdict; why: string | null; costUsd: number; now: Date }
): void {
  const row = db.select().from(finding).where(eq(finding.id, id)).get()
  if (row === undefined) return
  db.update(finding)
    .set({
      confirm: input.confirm,
      confirmWhy: input.why,
      confirmedAt: input.now.toISOString(),
      costUsd: row.costUsd + input.costUsd,
      state:
        row.state === 'held' || row.state === 'hidden'
          ? row.state
          : findingState({
              held: false,
              hidden: false,
              verdictAb: row.verdictAb,
              verdictBa: row.verdictBa,
              confirm: input.confirm
            })
    })
    .where(eq(finding.id, id))
    .run()
}

/** Marks findings as drawn as underlines, once (slice 5). */
export function markShown(db: TreeDb, ids: readonly string[], now: Date): void {
  if (ids.length === 0) return
  for (const id of ids) {
    const row = db
      .select({ shownAt: finding.shownAt })
      .from(finding)
      .where(eq(finding.id, id))
      .get()
    if (row?.shownAt !== null) continue
    db.update(finding).set({ shownAt: now.toISOString() }).where(eq(finding.id, id)).run()
  }
}

/**
 * The invariants' view of a draft's findings: each one's state, verdicts, *Not a problem* key and
 * whether each claim side is a live claim of the draft in a readable scene (`readable`).
 */
export function invariantFindings(
  db: TreeDb,
  draftId: string,
  readable: (nodeId: string) => boolean
): InvariantFinding[] {
  const claims = new Map(
    db
      .select({ id: claim.id, state: claim.state, nodeId: claim.nodeId, draftId: claim.draftId })
      .from(claim)
      .where(eq(claim.draftId, draftId))
      .all()
      .map((row) => [row.id, row])
  )
  return findingsOf(db, draftId).map((each) => ({
    id: each.id,
    state: each.state,
    verdictAb: each.verdictAb,
    verdictBa: each.verdictBa,
    npKey: each.npKey,
    claimSides: [each.a, each.b].flatMap((side) => {
      if (side.kind !== 'claim') return []
      const row = claims.get(side.claimId)
      return [
        {
          claimId: side.claimId,
          live: row?.state === 'live' && readable(row.nodeId)
        }
      ]
    })
  }))
}
