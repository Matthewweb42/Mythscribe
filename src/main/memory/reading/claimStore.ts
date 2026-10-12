import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ClaimPending,
  valueKey,
  type Claim,
  type ClaimProof,
  type ClaimState
} from '@shared/memory/claims'
import type { InvariantClaim } from '@shared/memory/invariants'
import { parseSlot, type Slot } from '@shared/memory/slots'
import type { MemorySource } from '@shared/memory/sources'
import { claim, type ClaimRow } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { sceneStatuses } from '../passageIndexer'

/**
 * The claims of story memory v2 (F-16.17): the one writer of `claim`. Rows are keyed by scene and
 * draft; only the active draft's are live (design §2.2), so every reader here asks for a draft.
 * JSON columns (`pending`, `anchor`) are read leniently: a row that no longer parses (a hand-edited
 * file, a slot retired) is skipped, never thrown on.
 */

const Hashes = z.array(z.string())

function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A stored row as a claim; null when it no longer parses. */
export function toClaim(row: ClaimRow): Claim | null {
  const slot = parseSlot(row.slot)
  const anchor = parseJson(row.anchor, Hashes)
  const pending = row.pending === null ? null : parseJson(row.pending, ClaimPending)
  if (slot === null || anchor === null || (row.pending !== null && pending === null)) return null
  return {
    id: row.id,
    nodeId: row.nodeId,
    draftId: row.draftId,
    readingId: row.readingId,
    recordId: row.recordId,
    pending,
    subjectText: row.subjectText,
    slot,
    value: row.value,
    valueKey: row.valueKey,
    objectId: row.objectId,
    how: row.how,
    fromId: row.fromId,
    voice: row.voice,
    speakerId: row.speakerId,
    mode: row.mode,
    quote: row.quote,
    para: row.para,
    anchor,
    proof: row.proof,
    change: row.change,
    state: row.state,
    spot: row.spot,
    spotTier: row.spotTier,
    spotAt: row.spotAt,
    created: row.created,
    proved: row.proved
  }
}

const toClaims = (rows: readonly ClaimRow[]): Claim[] =>
  rows.flatMap((row) => {
    const parsed = toClaim(row)
    return parsed === null ? [] : [parsed]
  })

/** A claim to store: what the ladder proved, where, and in which state. */
export interface NewClaim {
  nodeId: string
  draftId: string
  readingId: string | null
  recordId: string | null
  pending: ClaimPending | null
  subjectText: string | null
  slot: Slot
  value: string
  objectId: string | null
  voice: Claim['voice']
  speakerId: string | null
  mode: Claim['mode']
  quote: string
  para: number
  anchor: readonly string[]
  proof: ClaimProof
  change: boolean
  state: ClaimState
}

/** Stores claims; answers their ids, in order. */
export function insertClaims(db: TreeDb, claims: readonly NewClaim[], now: Date): string[] {
  const at = now.toISOString()
  const ids: string[] = []
  db.transaction((tx) => {
    for (const each of claims) {
      const id = randomUUID()
      tx.insert(claim)
        .values({
          id,
          nodeId: each.nodeId,
          draftId: each.draftId,
          readingId: each.readingId,
          recordId: each.recordId,
          pending: each.pending === null ? null : JSON.stringify(each.pending),
          subjectText: each.subjectText,
          slot: each.slot,
          value: each.value,
          valueKey: valueKey(each.value),
          objectId: each.objectId,
          how: null,
          fromId: null,
          voice: each.voice,
          speakerId: each.speakerId,
          mode: each.mode,
          quote: each.quote,
          para: each.para,
          anchor: JSON.stringify(each.anchor),
          proof: each.proof,
          change: each.change,
          state: each.state,
          created: at,
          proved: at
        })
        .run()
      ids.push(id)
    }
  })
  return ids
}

export function getClaim(db: TreeDb, id: string): Claim | null {
  const row = db.select().from(claim).where(eq(claim.id, id)).get()
  return row === undefined ? null : toClaim(row)
}

/** One scene's claims in one draft, in paragraph order. */
export function sceneClaims(db: TreeDb, nodeId: string, draftId: string): Claim[] {
  return toClaims(
    db
      .select()
      .from(claim)
      .where(and(eq(claim.nodeId, nodeId), eq(claim.draftId, draftId)))
      .orderBy(asc(claim.para), asc(claim.created), sql`rowid`)
      .all()
  )
}

/** One record's claims in one draft (as subject). */
export function recordClaims(db: TreeDb, recordId: string, draftId: string): Claim[] {
  return toClaims(
    db
      .select()
      .from(claim)
      .where(and(eq(claim.recordId, recordId), eq(claim.draftId, draftId)))
      .orderBy(asc(claim.created), sql`rowid`)
      .all()
  )
}

/** Every claim of one draft in one state. */
export function claimsByState(db: TreeDb, state: ClaimState, draftId: string): Claim[] {
  return toClaims(
    db
      .select()
      .from(claim)
      .where(and(eq(claim.state, state), eq(claim.draftId, draftId)))
      .orderBy(asc(claim.created), sql`rowid`)
      .all()
  )
}

/** Every claim of one draft. */
export function draftClaims(db: TreeDb, draftId: string): Claim[] {
  return toClaims(
    db
      .select()
      .from(claim)
      .where(eq(claim.draftId, draftId))
      .orderBy(asc(claim.created), sql`rowid`)
      .all()
  )
}

/**
 * A stale claim brought back by a fresh item: its quote, paragraph, anchor and proof replaced.
 * Only a claim with a record comes back live this way (a claim with no subject never does).
 */
export function reviveClaim(
  db: TreeDb,
  id: string,
  fresh: {
    quote: string
    para: number
    anchor: readonly string[]
    proof: ClaimProof
    readingId: string | null
  },
  now: Date
): void {
  db.update(claim)
    .set({
      quote: fresh.quote,
      para: fresh.para,
      anchor: JSON.stringify(fresh.anchor),
      proof: fresh.proof,
      readingId: fresh.readingId,
      state: 'live',
      proved: now.toISOString()
    })
    .where(and(eq(claim.id, id), isNotNull(claim.recordId)))
    .run()
}

/** A claim whose anchor holds, following its quote to another paragraph (`moved`). */
export function setClaimPara(db: TreeDb, id: string, para: number): void {
  db.update(claim).set({ para }).where(eq(claim.id, id)).run()
}

/**
 * A stale claim whose anchor holds in place again (`restored`): back to `live`, or to `waiting`
 * when it still waits on its subject, with its quote's paragraph now. Its proof stands as it was.
 */
export function restoreClaim(
  db: TreeDb,
  id: string,
  para: number,
  state: 'live' | 'waiting'
): void {
  db.update(claim).set({ para, state }).where(eq(claim.id, id)).run()
}

/** A literal claim re-proved for free: live, with its new paragraph and anchor. */
export function reanchorClaim(
  db: TreeDb,
  id: string,
  fresh: { para: number; anchor: readonly string[] },
  now: Date
): void {
  db.update(claim)
    .set({
      para: fresh.para,
      anchor: JSON.stringify(fresh.anchor),
      state: 'live',
      proved: now.toISOString()
    })
    .where(eq(claim.id, id))
    .run()
}

export function setClaimsState(db: TreeDb, ids: readonly string[], state: ClaimState): void {
  if (ids.length === 0) return
  db.update(claim)
    .set({ state })
    .where(inArray(claim.id, [...ids]))
    .run()
}

export function deleteClaims(db: TreeDb, ids: readonly string[]): void {
  if (ids.length === 0) return
  db.delete(claim)
    .where(inArray(claim.id, [...ids]))
    .run()
}

/**
 * Waiting claims settled onto a record (the author's Yes, or a shared alias the name scan now
 * resolves): live, the record set, nothing pending. The caller checks the anchor first (design
 * §2.2 identity rule 7).
 */
export function attachClaims(
  db: TreeDb,
  ids: readonly string[],
  recordId: string,
  now: Date
): void {
  if (ids.length === 0) return
  db.update(claim)
    .set({ recordId, pending: null, state: 'live', proved: now.toISOString() })
    .where(inArray(claim.id, [...ids]))
    .run()
}

/** Writes a claim row as it is (Rename in book's rewrite, and its undo). */
export function writeClaimRow(db: TreeDb, row: ClaimRow): void {
  db.update(claim).set(row).where(eq(claim.id, row.id)).run()
}

/** The raw rows of some claims (Rename in book's undo keeps them). */
export function claimRows(db: TreeDb, ids: readonly string[]): ClaimRow[] {
  if (ids.length === 0) return []
  return db
    .select()
    .from(claim)
    .where(inArray(claim.id, [...ids]))
    .all()
}

/** The raw rows of one scene in one draft. */
export function sceneClaimRows(db: TreeDb, nodeId: string, draftId: string): ClaimRow[] {
  return db
    .select()
    .from(claim)
    .where(and(eq(claim.nodeId, nodeId), eq(claim.draftId, draftId)))
    .all()
}

/**
 * Where each scene's claims count as read from (design §2.2): a manuscript scene is `scene`, one
 * with the Idea status `ideaScene`, one left out of compile `excludedScene`, and a node outside
 * the manuscript `notCanon` (never real).
 */
export function claimSources(db: TreeDb): (nodeId: string) => MemorySource {
  const scenes = new Set(manuscriptDocuments(db).map((row) => row.id))
  const statuses = sceneStatuses(db)
  return (nodeId) => {
    if (!scenes.has(nodeId)) return 'notCanon'
    if (statuses.idea.has(nodeId)) return 'ideaScene'
    if (statuses.excluded.has(nodeId)) return 'excludedScene'
    return 'scene'
  }
}

/**
 * The active draft's claims as P0's invariants read them (`checkMemoryInvariants`); `nodeId`
 * narrows them to one scene. Other drafts' rows are never live, so they are not checked.
 */
export function invariantClaims(db: TreeDb, nodeId?: string): InvariantClaim[] {
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const source = claimSources(db)
  const rows = nodeId === undefined ? draftClaims(db, draftId) : sceneClaims(db, nodeId, draftId)
  return rows.map((each) => ({
    id: each.id,
    sceneId: each.nodeId,
    source: source(each.nodeId),
    state: each.state,
    proof: each.proof,
    anchor: each.anchor
  }))
}
