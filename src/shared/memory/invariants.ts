import { anchorHolds, type MemoryAnchor } from './anchor'
import type { RecordKind } from './records'
import { readerMayRead, type MemorySource } from './sources'

/**
 * The memory invariants (F-16.3; design §2.3, "Measuring accuracy without a gold set", 1):
 * checked in tests and, from P2a, on save. Each one is a property the stored memory must have
 * whatever the model did; a violation is a bug in the code that stored it, never a judgement
 * about the book.
 *
 * The input rows are minimal on purpose, so P2a maps its own tables onto them without these
 * types reaching the schema.
 */

/** The proofs a stored claim may carry: code (`literal`) or the verifier (`verified`). */
export const CLAIM_PROOFS = ['literal', 'verified'] as const

export interface InvariantClaim {
  id: string
  /** The scene the claim's quote is in. */
  sceneId: string
  /** Where the claim was read from; only `scene` is ever readable. */
  source: MemorySource
  /**
   * `live` claims are shown and used; `stale`, `waiting` and `suggested` ones are not (a
   * suggestion's anchor must hold like a live claim's).
   */
  state: 'live' | 'stale' | 'waiting' | 'suggested'
  /** `literal` or `verified` for every stored claim; anything else is a violation. */
  proof: string | null
  anchor: MemoryAnchor
}

export interface InvariantAlias {
  recordId: string
  /** The alias's matching form. */
  norm: string
  /** Whether the author marked this alias as shared between records. */
  shared: boolean
}

export interface InvariantCitation {
  /** The answer (a chat turn, an instant answer) that cites it. */
  answerId: string
  /** What is cited: a passage (manuscript, sheet, note, Research) or a card, which never may be. */
  target: 'passage' | 'card'
  ref: string
}

/** A knows claim (P2b): its learner's kind and its object's (null when either is gone). */
export interface InvariantKnows {
  claimId: string
  state: 'live' | 'stale' | 'waiting' | 'suggested'
  learnerKind: RecordKind | null
  objectKind: RecordKind | null
}

/** A secret or thread record (P2b): who made it and what still backs it. */
export interface InvariantTopic {
  recordId: string
  origin: string
  /** Its reveals (`topic_quote`) in any draft. */
  quotes: number
  /** Claims about it (knows claims' object, thread steps' record) in any draft. */
  claims: number
  /** The author wrote on it (Pinned or Ideas) or marked someone as knowing it before the book. */
  authorTouched: boolean
}

/**
 * A stored finding (P4, F-16.27): its state, both verdicts, its *Not a problem* key, and each
 * claim side's standing (a live claim of the active draft in a readable scene, or not).
 */
export interface InvariantFinding {
  id: string
  state: string
  verdictAb: string | null
  verdictBa: string | null
  npKey: string
  claimSides: readonly { claimId: string; live: boolean }[]
}

export type InvariantViolation =
  | { kind: 'anchorMissing'; claimId: string; sceneId: string; missing: string[] }
  | { kind: 'anchorEmpty'; claimId: string; sceneId: string }
  | { kind: 'unproved'; claimId: string; proof: string | null }
  | { kind: 'aliasClash'; norm: string; recordIds: string[] }
  | { kind: 'unreadableSource'; claimId: string; source: MemorySource }
  | { kind: 'citesCard'; answerId: string; ref: string }
  | { kind: 'knowsObject'; claimId: string }
  | { kind: 'knowsLearner'; claimId: string }
  | { kind: 'topicEmpty'; recordId: string }
  | { kind: 'topicName'; recordId: string }
  | { kind: 'findingUnjudged'; findingId: string }
  | { kind: 'findingDismissed'; findingId: string }
  | { kind: 'findingSide'; findingId: string; claimId: string }

export interface InvariantInput {
  claims: readonly InvariantClaim[]
  /** Each scene's current sentence hashes (`sceneSentences(...).map(s => s.hash)`). */
  sceneHashes: ReadonlyMap<string, ReadonlySet<string>>
  aliases: readonly InvariantAlias[]
  citations: readonly InvariantCitation[]
  /** P2b: every knows claim (slot `knows`). */
  knows?: readonly InvariantKnows[]
  /** P2b: every secret and thread record. */
  topics?: readonly InvariantTopic[]
  /** P2b: every record the name index holds (mentions, the scan's roster), with its kind. */
  indexed?: readonly { recordId: string; kind: RecordKind }[]
  /** P4: the active draft's findings, and the *Not a problem* keys on the Dismissed list. */
  findings?: readonly InvariantFinding[]
  dismissedFindings?: ReadonlySet<string>
}

const NO_HASHES: ReadonlySet<string> = new Set()

/**
 * Every violation of the invariants (claims first, then aliases, then citations):
 * - `anchorMissing`: a live claim whose anchor hashes are not all in its scene;
 * - `anchorEmpty`: a live claim with no anchor at all (its quote named no sentence of the scene,
 *   `anchorFor` gave `[]`), which `anchorHolds` would pass vacuously and no edit could ever stale;
 * - `unproved`: a claim whose proof is neither `literal` nor `verified`;
 * - `aliasClash`: one `norm` belonging to two or more records when not every one of its aliases
 *   is shared;
 * - `unreadableSource`: a claim read from anything but a manuscript scene;
 * - `citesCard`: an answer citing a card (a card is a map, never evidence);
 * - P2b: `knowsObject`, a knows claim whose object is not a secret; `knowsLearner`, a knows claim
 *   (not waiting) whose learner is not a character or a group; `topicEmpty`, an AI-made secret or
 *   thread with no reveal and no claim left in any draft and nothing from the author (it should
 *   have been pruned, P2b-D12); `topicName`, a secret or thread in the name index (they are not
 *   names, P2b-D2).
 * - P4: `findingUnjudged`, an open finding without two "contradiction" verdicts; `findingDismissed`,
 *   a stored finding whose *Not a problem* key is on the Dismissed list (it should have closed);
 *   `findingSide`, an open finding whose claim side is not a live claim of the active draft in a
 *   readable scene.
 * An empty list is a clean memory.
 */
export function checkMemoryInvariants(input: InvariantInput): InvariantViolation[] {
  const violations: InvariantViolation[] = []

  for (const claim of input.claims) {
    const held = claim.state === 'live' || claim.state === 'suggested'
    if (held && claim.anchor.length === 0) {
      violations.push({ kind: 'anchorEmpty', claimId: claim.id, sceneId: claim.sceneId })
    } else if (held) {
      const present = input.sceneHashes.get(claim.sceneId) ?? NO_HASHES
      if (!anchorHolds(claim.anchor, present)) {
        violations.push({
          kind: 'anchorMissing',
          claimId: claim.id,
          sceneId: claim.sceneId,
          missing: claim.anchor.filter((hash) => !present.has(hash))
        })
      }
    }
    if (!CLAIM_PROOFS.some((proof) => proof === claim.proof)) {
      violations.push({ kind: 'unproved', claimId: claim.id, proof: claim.proof })
    }
    if (!readerMayRead(claim.source)) {
      violations.push({ kind: 'unreadableSource', claimId: claim.id, source: claim.source })
    }
  }

  const byNorm = new Map<string, InvariantAlias[]>()
  for (const alias of input.aliases) {
    byNorm.set(alias.norm, [...(byNorm.get(alias.norm) ?? []), alias])
  }
  for (const [norm, aliases] of byNorm) {
    const recordIds = [...new Set(aliases.map((alias) => alias.recordId))]
    if (recordIds.length > 1 && !aliases.every((alias) => alias.shared)) {
      violations.push({ kind: 'aliasClash', norm, recordIds })
    }
  }

  for (const citation of input.citations) {
    if (citation.target === 'card') {
      violations.push({ kind: 'citesCard', answerId: citation.answerId, ref: citation.ref })
    }
  }

  for (const knows of input.knows ?? []) {
    if (knows.objectKind !== 'secret') {
      violations.push({ kind: 'knowsObject', claimId: knows.claimId })
    }
    if (
      knows.state !== 'waiting' &&
      knows.learnerKind !== 'character' &&
      knows.learnerKind !== 'group'
    ) {
      violations.push({ kind: 'knowsLearner', claimId: knows.claimId })
    }
  }
  for (const topic of input.topics ?? []) {
    if (topic.origin === 'ai' && topic.quotes === 0 && topic.claims === 0 && !topic.authorTouched) {
      violations.push({ kind: 'topicEmpty', recordId: topic.recordId })
    }
  }
  const named = new Set<string>()
  for (const entry of input.indexed ?? []) {
    if ((entry.kind === 'secret' || entry.kind === 'thread') && !named.has(entry.recordId)) {
      named.add(entry.recordId)
      violations.push({ kind: 'topicName', recordId: entry.recordId })
    }
  }
  const dismissedFindings = input.dismissedFindings ?? new Set<string>()
  for (const finding of input.findings ?? []) {
    if (finding.state === 'open' && (finding.verdictAb !== 'c' || finding.verdictBa !== 'c')) {
      violations.push({ kind: 'findingUnjudged', findingId: finding.id })
    }
    if (dismissedFindings.has(finding.npKey)) {
      violations.push({ kind: 'findingDismissed', findingId: finding.id })
    }
    if (finding.state !== 'open') continue
    for (const side of finding.claimSides) {
      if (!side.live) {
        violations.push({ kind: 'findingSide', findingId: finding.id, claimId: side.claimId })
      }
    }
  }
  return violations
}
