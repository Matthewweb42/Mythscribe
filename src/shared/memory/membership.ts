import type { ClaimMode, ClaimState, ClaimVoice } from './claims'
import { namesRecord, type NoteName, type NoteParagraph } from './noteValues'
import type { RecordKind } from './records'
import type { Slot } from './slots'

/**
 * Group membership (F-16.27; P4-D5, which P2b left to P4): which group records a character belongs
 * to, read in code from what the book and the author's notes say. Used by C3 alone, to skip "told
 * before learning" when the character's group already knew (so it can only remove a candidate).
 * Pure.
 */

/** A claim as membership reads it. */
export interface MembershipClaim {
  recordId: string
  slot: Slot
  value: string
  objectId: string | null
  voice: ClaimVoice
  mode: ClaimMode
  state: ClaimState
}

/** A record as membership reads it. */
export interface MembershipRecord {
  kind: RecordKind
  names: readonly NoteName[]
}

export interface MembershipInput {
  claims: readonly MembershipClaim[]
  records: ReadonlyMap<string, MembershipRecord>
  /** Canon Pinned paragraphs (owner kind `record`). */
  pinned: readonly NoteParagraph[]
}

/** The lasting slots whose value may name a group the character belongs to. */
export const MEMBERSHIP_SLOTS: readonly Slot[] = [
  'role',
  'detail:allegiance',
  'detail:rank',
  'detail:occupation',
  'detail:home'
]

/**
 * The groups a character belongs to (P4-D5): a live narration claim of the character whose object
 * is the group (a relation or kinship); a live narration claim in a lasting slot (role, allegiance,
 * rank, occupation, home) whose value names the group; or a canon Pinned paragraph on either sheet
 * that names the other record.
 */
export function groupsOf(recordId: string, input: MembershipInput): Set<string> {
  const groups = new Set<string>()
  const self = input.records.get(recordId)
  if (self === undefined) return groups
  const all = [...input.records].filter(([, record]) => record.kind === 'group')
  for (const claim of input.claims) {
    if (claim.recordId !== recordId || claim.state !== 'live' || claim.voice !== 'narration') {
      continue
    }
    if (claim.objectId !== null && input.records.get(claim.objectId)?.kind === 'group') {
      groups.add(claim.objectId)
    }
    if (MEMBERSHIP_SLOTS.includes(claim.slot)) {
      for (const [groupId, group] of all) {
        if (namesRecord(claim.value, group.names)) groups.add(groupId)
      }
    }
  }
  for (const paragraph of input.pinned) {
    if (paragraph.ownerKind !== 'record') continue
    if (paragraph.ownerId === recordId) {
      for (const [groupId, group] of all) {
        if (namesRecord(paragraph.text, group.names)) groups.add(groupId)
      }
    } else if (
      all.some(([groupId]) => groupId === paragraph.ownerId) &&
      namesRecord(paragraph.text, self.names)
    ) {
      groups.add(paragraph.ownerId)
    }
  }
  return groups
}
