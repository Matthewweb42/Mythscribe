import type { Claim } from '@shared/memory/claims'
import type { Dismissed } from '@shared/memory/dismissed'
import { HOW_LABEL, parseHow } from '@shared/memory/knows'
import { readerMayRead } from '@shared/memory/sources'
import { slotLabel } from '@shared/memory/slots'
import type { SuggestionScope, SuggestionView } from '@shared/memory/views'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { listRecords } from '../recordStore'
import { claimSources, claimsByState, getClaim, setClaimsState } from './claimStore'
import { dismissClaimsNotRight } from './notRight'
import { readingOrder } from './readingFrame'
import { claimView } from './views'

/**
 * Story memory as suggestions you approve (F-16.17; plan `Suggestions.md`, the author's decision
 * of 2026-10-14): every fact a reading proves is stored `suggested`, and nothing reads it as memory
 * (sheets, True now, ages, the Timeline, who knows what, threads, contradictions, Ms Scribe) until
 * the author accepts it. This module is the one owner of the three answers:
 *
 * - **List** (`listSuggestions`): the active draft's suggestions in readable scenes, by scene,
 *   record (a knows line counts for its secret too) or claim ids, best first (literal proof, then
 *   verified; answer 3: no limit), then in reading order.
 * - **Accept** (`acceptSuggestions`): suggested → `live`, the author's mark (a line she accepted is
 *   live from then on, and a stale one comes back live when its sentence does); with `undo`, live
 *   → suggested again (the toast's *Undo*).
 * - **Dismiss** (`dismissSuggestions`): *Not right › Wrong value* on each (`dismissClaimsNotRight`):
 *   a `notRight` Dismissed row keyed by its sentence, so the same sentence never suggests it again,
 *   and *Undo* in Dismissed brings it back as a suggestion.
 *
 * Nothing here reads or writes scene text, and no request is sent.
 */

const NO_SCENE = Number.MAX_SAFE_INTEGER

/** The words of a suggestion as a sheet would say them, and who says it or how, when not plain. */
function suggestionWords(
  claim: Claim,
  names: ReadonlyMap<string, string>
): { line: string; note: string | null } {
  const name = (id: string | null): string => (id === null ? '' : (names.get(id) ?? ''))
  let line: string
  if (claim.slot === 'knows') {
    const how = parseHow(claim.how)
    const from = claim.fromId === null ? '' : `, from ${name(claim.fromId)}`
    line = `knows ${name(claim.objectId)} (${how === null ? (claim.how ?? claim.value) : HOW_LABEL[how]}${from})`
  } else if (claim.slot === 'thread') {
    line = `${claim.how ?? ''} ${claim.value}`.trim()
  } else {
    const object = claim.objectId === null ? '' : ` (${name(claim.objectId)})`
    line = `${slotLabel(claim.slot)}: ${claim.value}${object}`
  }
  const notes: string[] = []
  const speaker = name(claim.speakerId)
  if (claim.voice === 'dialogue') notes.push(speaker === '' ? 'said' : `${speaker} says`)
  if (claim.voice === 'thought') notes.push(speaker === '' ? 'thought' : `${speaker} thinks`)
  if (claim.voice === 'rumour') notes.push('rumour')
  if (claim.mode === 'memory') notes.push('remembered')
  if (claim.mode === 'hypothetical') notes.push('supposed')
  if (claim.mode === 'dream') notes.push('dreamt')
  return { line, note: notes.length === 0 ? null : notes.join(', ') }
}

/** The active draft's suggestions in readable scenes, as the scope narrows them. */
function scoped(db: TreeDb, scope: SuggestionScope): Claim[] {
  const draftId = currentDraftId(db)
  if (draftId === null) return []
  const readable = claimSources(db)
  const ids = scope.claimIds === undefined ? null : new Set(scope.claimIds)
  return claimsByState(db, 'suggested', draftId).filter(
    (claim) =>
      claim.recordId !== null &&
      readerMayRead(readable(claim.nodeId)) &&
      (scope.nodeId === undefined || claim.nodeId === scope.nodeId) &&
      (scope.recordId === undefined ||
        claim.recordId === scope.recordId ||
        (claim.slot === 'knows' && claim.objectId === scope.recordId)) &&
      (ids === null || ids.has(claim.id))
  )
}

/** The suggestions in `scope`, best first: literal, then verified; then in reading order. */
export function listSuggestions(db: TreeDb, scope: SuggestionScope = {}): SuggestionView[] {
  const claims = scoped(db, scope)
  if (claims.length === 0) return []
  const reading = readingOrder(db)
  const names = new Map(listRecords(db).map((record) => [record.id, record.name]))
  const rank = (claim: Claim): number => (claim.proof === 'literal' ? 0 : 1)
  return [...claims]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (reading.order.get(a.nodeId) ?? NO_SCENE) - (reading.order.get(b.nodeId) ?? NO_SCENE) ||
        a.para - b.para
    )
    .map((claim) => ({
      ...claimView(claim, reading),
      name: names.get(claim.recordId ?? '') ?? '',
      ...suggestionWords(claim, names)
    }))
}

/** How many suggestions of the active draft wait for the author (the status bar's count). */
export function suggestionCount(db: TreeDb): number {
  return scoped(db, {}).length
}

/** What an answer touched: the claims, their scenes and the records whose memory moved. */
export interface SuggestionChange {
  claimIds: string[]
  nodeIds: string[]
  recordIds: string[]
}

function touched(claims: readonly Claim[]): SuggestionChange {
  return {
    claimIds: claims.map((claim) => claim.id),
    nodeIds: [...new Set(claims.map((claim) => claim.nodeId))],
    recordIds: [
      ...new Set(
        claims.flatMap((claim) =>
          [claim.recordId, claim.slot === 'knows' ? claim.objectId : null].filter(
            (id): id is string => id !== null
          )
        )
      )
    ]
  }
}

const claimsOf = (db: TreeDb, ids: readonly string[]): Claim[] =>
  [...new Set(ids)].flatMap((id) => {
    const claim = getClaim(db, id)
    return claim === null ? [] : [claim]
  })

/**
 * *Accept*: these suggestions become the author's (`live`); with `undo`, these accepted lines are
 * suggestions again. A claim in any other state (dismissed meanwhile, gone stale, waiting) is left
 * as it is.
 */
export function acceptSuggestions(
  db: TreeDb,
  ids: readonly string[],
  undo = false
): SuggestionChange {
  const from = undo ? 'live' : 'suggested'
  const claims = claimsOf(db, ids).filter(
    (claim) => claim.state === from && claim.recordId !== null
  )
  setClaimsState(
    db,
    claims.map((claim) => claim.id),
    undo ? 'suggested' : 'live'
  )
  return touched(claims)
}

/**
 * *Dismiss*: each suggestion goes to the Dismissed list as *Not right › Wrong value* does, so the
 * same sentence never suggests it again; *Undo* in Dismissed brings it back as it was.
 */
export function dismissSuggestions(
  db: TreeDb,
  ids: readonly string[],
  now: Date
): SuggestionChange & { dismissed: Dismissed[] } {
  const claims = claimsOf(db, ids).filter(
    (claim) => claim.state === 'suggested' && claim.recordId !== null
  )
  const dismissed = db.transaction((tx) => dismissClaimsNotRight(tx, claims, now))
  return { ...touched(claims), dismissed }
}
