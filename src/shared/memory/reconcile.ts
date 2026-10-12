import { anchorInPlace } from './anchor'
import type { Claim, ClaimPending, ClaimProof } from './claims'
import { dismissedKey } from './dismissed'

/**
 * Reconciliation (F-16.17; design §2.3 "Reconciliation"): what a reading's fresh claims do to
 * the scene's stored ones. Pure: the pipeline (slice 2) applies the result in one transaction.
 *
 * - `same` (the reader's word that a stored claim is unchanged) counts only for a live claim whose
 *   anchor still holds in place.
 * - A stale claim with a record comes back only through a fresh item with its own quote that
 *   passed the ladder, about the same record, slot, voice, mode and value: the item replaces its
 *   quote and anchor (a revival). A waiting claim is never revived: a claim waiting on its subject
 *   is told apart by its candidates and name span, and a claim with no record never comes back
 *   live this way.
 * - `drop` counts only for a stale claim, or one whose current quote the verifier rejected.
 * - Values merge by containment within one reading only ("grey" and "grey-blue" keep the
 *   longer); across scenes they sit side by side (`asOf.ts`).
 * - A fresh item on the Dismissed list (`notRight`, by record, slot, value and the quote's own
 *   sentences) is dropped before storing, unless the author moved that line to another record
 *   (*Not right › Not about*, `movedTo`): it is then stored for that record, so a rebuild keeps
 *   her choice.
 * - A fresh item that states a stored live or waiting claim again, word for word, is not stored
 *   twice: the stored claim stays as it is.
 * - P2a-D23: a stale claim whose paragraph lay inside the window read, and that no fresh item
 *   revived, is deleted (a claim waiting on its subject whose sentences changed is stale too); a
 *   full read deletes every stale and pronoun-waiting claim it did not revive or restate. Claims
 *   waiting on a new name wait for the author, and claims waiting on a shared alias for the name
 *   scan (P2a-D22).
 */

/** A stored claim as reconciliation reads it. */
export type StoredClaim = Pick<
  Claim,
  | 'id'
  | 'recordId'
  | 'pending'
  | 'subjectText'
  | 'slot'
  | 'valueKey'
  | 'voice'
  | 'mode'
  | 'speakerId'
  | 'objectId'
  | 'state'
  | 'quote'
  | 'para'
  | 'anchor'
>

/** A fresh item that passed the ladder, ready to store. */
export interface FreshClaim {
  recordId: string | null
  pending: ClaimPending | null
  subjectText: string | null
  slot: Claim['slot']
  value: string
  valueKey: string
  objectId: string | null
  voice: Claim['voice']
  speakerId: string | null
  mode: Claim['mode']
  quote: string
  para: number
  anchor: string[]
  /** The gate texts (`gateText`) of the quote's own sentences: what a Not right dismissal keys on. */
  stating: string[]
  proof: ClaimProof
  change: boolean
}

export interface ReconcileInput {
  stored: readonly StoredClaim[]
  /**
   * The paragraphs the reading sent, and whether it was a full read. `replace` (a *Rebuild
   * memory* read, P2a-D25): every stored claim the reading did not state again, revive or confirm
   * (`same`) goes, but for claims waiting on the author (a new name) or on the name scan (a shared
   * alias).
   */
  window: { paras: ReadonlySet<number>; full: boolean; replace?: boolean }
  /** The scene's current sentence hashes, in reading order (`sceneSentences`). */
  hashes: readonly string[]
  same: readonly string[]
  drop: readonly string[]
  /** Stored claims whose current quote the verifier rejected in this reading. */
  rejected: ReadonlySet<string>
  fresh: readonly FreshClaim[]
  /** Every `notRight` key on the Dismissed list. */
  dismissed: ReadonlySet<string>
  /**
   * The `notRight` keys of lines the author moved to another record (*Not about*), to that record:
   * a fresh item with one of these keys is stored for that record rather than dropped.
   */
  movedTo?: ReadonlyMap<string, string>
}

export interface Revival {
  id: string
  quote: string
  para: number
  anchor: string[]
  proof: ClaimProof
}

export interface ReconcileResult {
  inserts: FreshClaim[]
  revivals: Revival[]
  deletes: string[]
  /** Stored live claims the reader confirmed unchanged (`same`, anchor holding). */
  kept: string[]
  /** Fresh items folded into a longer value of the same reading. */
  merged: number
  /** Fresh items dropped as Dismissed. */
  dismissed: number
}

/** Who a claim is about: its record, the new name it waits on, or its candidates and name span. */
function subjectOf(claim: {
  recordId: string | null
  pending: ClaimPending | null
  subjectText: string | null
}): string {
  if (claim.recordId !== null) return claim.recordId
  if (claim.pending?.kind === 'name') return `name:${claim.pending.norm}`
  const candidates = claim.pending?.kind === 'subject' ? [...claim.pending.candidates].sort() : []
  return `subject:${candidates.join(',')}:${claim.subjectText ?? ''}`
}

/** Who and what a claim is about, without its value: claims with one identity compare values. */
const identity = (claim: {
  recordId: string | null
  pending: ClaimPending | null
  subjectText: string | null
  slot: string
  voice: string
  mode: string
  speakerId: string | null
  objectId: string | null
}): string =>
  [
    subjectOf(claim),
    claim.slot,
    claim.voice,
    claim.mode,
    claim.speakerId ?? '',
    claim.objectId ?? ''
  ].join('|')

const WORD = /[\p{L}\p{N}]+/gu

/** Whether value key `long` holds `short` as a run of whole words ("grey-blue" holds "grey"). */
export function containsValue(long: string, short: string): boolean {
  if (long === short) return true
  const a = long.match(WORD) ?? []
  const b = short.match(WORD) ?? []
  if (b.length === 0 || b.length >= a.length) return false
  for (let i = 0; i + b.length <= a.length; i += 1) {
    if (b.every((word, j) => a[i + j] === word)) return true
  }
  return false
}

/** Folds the fresh items of one reading: of two values one holds, the longer stays. */
function mergeFresh(fresh: readonly FreshClaim[]): { kept: FreshClaim[]; merged: number } {
  const kept: FreshClaim[] = []
  let merged = 0
  for (const item of fresh) {
    const key = identity(item)
    const twin = kept.findIndex(
      (other) =>
        identity(other) === key &&
        (containsValue(other.valueKey, item.valueKey) ||
          containsValue(item.valueKey, other.valueKey))
    )
    const other = twin === -1 ? undefined : kept[twin]
    if (other === undefined) {
      kept.push(item)
      continue
    }
    merged += 1
    if (item.valueKey.length > other.valueKey.length) kept[twin] = item
  }
  return { kept, merged }
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const result: ReconcileResult = {
    inserts: [],
    revivals: [],
    deletes: [],
    kept: [],
    merged: 0,
    dismissed: 0
  }
  const undismissed = input.fresh.flatMap((item): FreshClaim[] => {
    if (item.recordId === null) return [item]
    const key = dismissedKey({
      kind: 'notRight',
      recordId: item.recordId,
      slot: item.slot,
      value: item.value,
      stating: item.stating
    })
    if (!input.dismissed.has(key)) return [item]
    const to = input.movedTo?.get(key)
    if (to !== undefined && to !== item.recordId) {
      return [{ ...item, recordId: to, pending: null, subjectText: null }]
    }
    result.dismissed += 1
    return []
  })
  const { kept: fresh, merged } = mergeFresh(undismissed)
  result.merged = merged

  const byId = new Map(input.stored.map((claim) => [claim.id, claim]))
  const holds = (claim: StoredClaim): boolean => anchorInPlace(claim.anchor, input.hashes)
  const revived = new Set<string>()
  /** Stored live or waiting claims a fresh item stated again word for word (kept as they are). */
  const restated = new Set<string>()
  const deleted = new Set<string>()

  for (const item of fresh) {
    const key = identity(item)
    const already = input.stored.find(
      (claim) =>
        (claim.state === 'live' || claim.state === 'waiting') &&
        identity(claim) === key &&
        claim.valueKey === item.valueKey &&
        claim.quote === item.quote
    )
    if (already !== undefined) {
      restated.add(already.id)
      continue
    }
    const stale = input.stored.find(
      (claim) =>
        claim.state === 'stale' &&
        claim.recordId !== null &&
        claim.pending === null &&
        !revived.has(claim.id) &&
        identity(claim) === key &&
        claim.valueKey === item.valueKey
    )
    if (stale !== undefined) {
      revived.add(stale.id)
      result.revivals.push({
        id: stale.id,
        quote: item.quote,
        para: item.para,
        anchor: item.anchor,
        proof: item.proof
      })
      continue
    }
    result.inserts.push(item)
  }

  for (const id of input.same) {
    const claim = byId.get(id)
    if (claim?.state === 'live' && holds(claim)) result.kept.push(id)
  }
  for (const id of input.drop) {
    const claim = byId.get(id)
    if (claim === undefined || revived.has(id)) continue
    if (claim.state === 'stale' || input.rejected.has(id)) deleted.add(id)
  }
  for (const claim of input.stored) {
    if (revived.has(claim.id) || restated.has(claim.id)) continue
    if (claim.state === 'stale' && (input.window.full || input.window.paras.has(claim.para))) {
      deleted.add(claim.id)
    }
    // A pronoun that fit more than one person (no name span); one waiting on a shared alias is
    // the anchors job's to settle (P2a-D22).
    const pronoun = claim.pending?.kind === 'subject' && claim.subjectText === null
    if (input.window.full && claim.state === 'waiting' && pronoun) {
      deleted.add(claim.id)
    }
    if (input.window.replace === true && !result.kept.includes(claim.id)) {
      const waitsOnOthers =
        claim.pending?.kind === 'name' ||
        (claim.pending?.kind === 'subject' && claim.subjectText !== null)
      if (!waitsOnOthers) deleted.add(claim.id)
    }
  }
  result.deletes = [...deleted]
  return result
}
