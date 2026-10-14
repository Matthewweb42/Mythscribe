import { randomUUID } from 'node:crypto'
import { and, count, eq, inArray } from 'drizzle-orm'
import type { Candidate } from '@shared/memory/candidates'
import {
  type Finding,
  FindingExtra,
  FindingRendered,
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
    confirmedAt: row.confirmedAt,
    rendered: renderedOf(row.rendered)
  }
}

/** A row's stored rendering; null when none was stored or it no longer parses. */
function renderedOf(raw: string | null): FindingRendered | null {
  if (raw === null) return null
  const parsed = FindingRendered.safeParse(parseJson(raw))
  return parsed.success ? parsed.data : null
}

/** A rendering as stored, its keys in one order whatever built it. */
const renderedJson = (rendered: FindingRendered | null): string | null =>
  rendered === null
    ? null
    : JSON.stringify({
        inputs: rendered.inputs,
        keys: rendered.keys === null ? null : { ab: rendered.keys.ab, ba: rendered.keys.ba }
      })

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

/** How many of a draft's findings are in a state. */
export function countFindings(db: TreeDb, draftId: string, state: FindingState): number {
  return (
    db
      .select({ n: count() })
      .from(finding)
      .where(and(eq(finding.draftId, draftId), eq(finding.state, state)))
      .get()?.n ?? 0
  )
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

/** Both orders' verdicts, as the cache remembers them for a pair's keys. */
export interface PairVerdicts {
  ab: JudgeVerdict | null
  ba: JudgeVerdict | null
  why: string | null
}

/**
 * How the recompute reads a candidate's pair as the judge would (`judge.ts`, through
 * `runFindingsJob`): `read` answers `stored` itself while the stamp of what its rendering reads
 * still holds (nothing is rendered), else a fresh rendering (its keys null when a side cannot be
 * rendered); `cached` the verdicts the cache holds under a rendering's keys.
 */
export interface PairReader {
  read(candidate: Candidate, stored: FindingRendered | null): FindingRendered
  cached(keys: NonNullable<FindingRendered['keys']>): PairVerdicts | null
}

/** What an upsert did. */
export interface UpsertResult {
  /** Ids of findings that are open now and were not before. */
  opened: string[]
  /** Rows written (inserted or changed). */
  written: number
  /** Of those, rows whose only change was their stored rendering (nothing a view shows moved). */
  restamped: number
}

const sameKeys = (x: FindingRendered['keys'], y: FindingRendered['keys']): boolean =>
  x !== null && y !== null && x.ab === y.ab && x.ba === y.ba

/**
 * Whether a kept row's verdicts no longer fit its candidate, so the pair must be judged again
 * (design §2.4: a verdict is keyed by the quotes, their context, their order, the modes and the
 * flashback): a side moved (a claim read again under a new id, a revival's new quote or a free
 * re-proof's new sentences, both hashed in `seen`; a note line that moved), the two sides swapped
 * order, the story year changed, or the flashback a scene's card gives came or went. A held row's
 * flashback is unknown (held masks it), so it is compared only between rows that are not held.
 */
function judgedPairMoved(
  row: FindingRow,
  each: Candidate,
  sides: { a: string; b: string; extra: string | null }
): boolean {
  if (row.a !== sides.a || row.b !== sides.b || row.extra !== sides.extra) return true
  return row.state !== 'held' && !each.held && (row.state === 'hidden') !== each.hidden
}

/**
 * Writes the candidates as findings of `draftId`, by key: a new key is inserted, `unjudged` unless
 * the cache knows its pair's verdicts; a kept key keeps its verdicts while its sides are unchanged
 * (`judgedPairMoved`) and the words the judge reads of them are too, else they are cleared (the
 * stronger check's too) and the cache asked for the new words, so an unchanged rendering is free and
 * a changed one is judged afresh. With `pairs`, a row is rendered again only when the stamp of what
 * its rendering reads moved (`PairReader.read`), and only a fresh rendering asks the cache: an
 * unchanged unjudged row costs nothing here (the judge asks the cache itself before sending). It
 * takes the candidate's sides and its held or hidden state. Nothing is written for a row
 * unchanged. `rows` is the draft's rows as they stand, when the caller has just read them.
 */
export function upsertFindings(
  db: TreeDb,
  draftId: string,
  candidates: readonly Candidate[],
  now: Date,
  pairs?: PairReader,
  rows: readonly FindingRow[] = findingRows(db, draftId)
): UpsertResult {
  const result: UpsertResult = { opened: [], written: 0, restamped: 0 }
  if (candidates.length === 0) return result
  const existing = new Map(rows.map((row) => [row.key, row]))
  db.transaction((tx) => {
    for (const each of candidates) {
      const row = existing.get(each.key)
      const a = JSON.stringify(each.a)
      const b = JSON.stringify(each.b)
      const extra = each.extra === null ? null : JSON.stringify(each.extra)
      const moved = row !== undefined && judgedPairMoved(row, each, { a, b, extra })
      // What the verdicts were given for, as stored: nothing once the sides moved.
      let renderedText = row === undefined || moved ? null : row.rendered
      let kept = row !== undefined && !moved ? row : null
      let fresh: NonNullable<FindingRendered['keys']> | null = null
      if (pairs !== undefined) {
        const stored = renderedOf(renderedText)
        const read = pairs.read(each, stored)
        if (read !== stored) {
          renderedText = renderedJson(read)
          // Rendered anew: the verdicts stand only for the very words they were given for.
          if (read.keys !== null && !sameKeys(stored?.keys ?? null, read.keys)) {
            kept = null
            fresh = read.keys
          }
        }
      }
      let verdictAb = kept?.verdictAb ?? null
      let verdictBa = kept?.verdictBa ?? null
      let why = kept?.why ?? null
      let judgedAt = kept?.judgedAt ?? null
      const confirm = kept?.confirm ?? null
      const confirmWhy = kept?.confirmWhy ?? null
      const confirmedAt = kept?.confirmedAt ?? null
      if (fresh !== null && pairs !== undefined) {
        const known = pairs.cached(fresh)
        if (known !== null && (known.ab !== null || known.ba !== null)) {
          verdictAb = known.ab
          verdictBa = known.ba
          why = known.why
          judgedAt = now.toISOString()
        }
      }
      const state = findingState({
        held: each.held,
        hidden: each.hidden,
        verdictAb,
        verdictBa,
        confirm
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
            judgedAt,
            rendered: renderedText
          })
          .run()
        result.written += 1
        if (state === 'open') result.opened.push(id)
        continue
      }
      const unmoved =
        row.a === a &&
        row.b === b &&
        row.extra === extra &&
        row.state === state &&
        row.verdictAb === verdictAb &&
        row.verdictBa === verdictBa &&
        row.confirm === confirm
      if (unmoved && row.rendered === renderedText) continue
      tx.update(finding)
        .set({
          a,
          b,
          extra,
          state,
          verdictAb,
          verdictBa,
          why,
          judgedAt,
          confirm,
          confirmWhy,
          confirmedAt,
          rendered: renderedText
        })
        .where(eq(finding.id, row.id))
        .run()
      result.written += 1
      if (unmoved) result.restamped += 1
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

/** A finding as it stood when its pair was rendered: what `setVerdicts` writes onto, and only onto. */
export interface FindingAsRendered {
  a: FindingSide
  b: FindingSide
  extra: FindingExtra | null
  rendered: FindingRendered | null
}

/** Whether a row still holds the finding as it was rendered (its sides, extra and rendering). */
function stillAsRendered(row: FindingRow, at: FindingAsRendered): boolean {
  const parsed = toFinding(row)
  return (
    parsed !== null &&
    JSON.stringify(parsed.a) === JSON.stringify(FindingSide.parse(at.a)) &&
    JSON.stringify(parsed.b) === JSON.stringify(FindingSide.parse(at.b)) &&
    JSON.stringify(parsed.extra) ===
      JSON.stringify(at.extra === null ? null : FindingExtra.parse(at.extra)) &&
    renderedJson(parsed.rendered) === renderedJson(at.rendered)
  )
}

/** A finding's state before and after `setVerdicts` wrote it. */
export interface VerdictsWritten {
  before: FindingState
  after: FindingState
}

/**
 * Stores a finding's verdicts in both orders, the judge's reason, its cost share and its state, and
 * (`rendered`) what they were given for. With `expect`, nothing but the cost share is written when
 * the row no longer holds the finding as it was rendered (a recompute re-stated it while the call
 * was out: its verdicts are for words the row no longer has; they stay in the verdict cache under
 * their own keys). Answers the states before and after, or null when nothing was written.
 */
export function setVerdicts(
  db: TreeDb,
  id: string,
  input: {
    ab: JudgeVerdict | null
    ba: JudgeVerdict | null
    why: string | null
    costUsd: number
    now: Date
    rendered?: FindingRendered | null
    expect?: FindingAsRendered
  }
): VerdictsWritten | null {
  const row = db.select().from(finding).where(eq(finding.id, id)).get()
  if (row === undefined) return null
  if (input.expect !== undefined && !stillAsRendered(row, input.expect)) {
    if (input.costUsd > 0) {
      db.update(finding)
        .set({ costUsd: row.costUsd + input.costUsd })
        .where(eq(finding.id, id))
        .run()
    }
    return null
  }
  const state =
    row.state === 'held' || row.state === 'hidden'
      ? row.state
      : findingState({
          held: false,
          hidden: false,
          verdictAb: input.ab,
          verdictBa: input.ba,
          confirm: row.confirm
        })
  db.update(finding)
    .set({
      verdictAb: input.ab,
      verdictBa: input.ba,
      why: input.why,
      costUsd: row.costUsd + input.costUsd,
      judgedAt: input.now.toISOString(),
      state,
      ...(input.rendered === undefined ? {} : { rendered: renderedJson(input.rendered) })
    })
    .where(eq(finding.id, id))
    .run()
  return { before: row.state, after: state }
}

/**
 * Stores the stronger check's verdict on an open finding (*Check the book*, F-16.30) with its cost,
 * and the state it gives (`ok` fine, `u` unclear, P4-D10). With `expect`, only the cost is added
 * when the row no longer holds the pair as it was rendered (a recompute re-stated it while the call
 * was out: the verdict stays remembered under its own words). `confirm` null adds the cost alone
 * (a reply that gave no verdict). Answers whether the verdict was written.
 */
export function setConfirm(
  db: TreeDb,
  id: string,
  input: {
    confirm: JudgeVerdict | null
    why: string | null
    costUsd: number
    now: Date
    expect?: FindingAsRendered
  }
): boolean {
  const row = db.select().from(finding).where(eq(finding.id, id)).get()
  if (row === undefined) return false
  if (
    input.confirm === null ||
    (input.expect !== undefined && !stillAsRendered(row, input.expect))
  ) {
    if (input.costUsd > 0) {
      db.update(finding)
        .set({ costUsd: row.costUsd + input.costUsd })
        .where(eq(finding.id, id))
        .run()
    }
    return false
  }
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
  return true
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
