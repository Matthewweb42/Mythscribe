import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { anchorHolds, sceneSentences } from '@shared/memory/anchor'
import type { Claim } from '@shared/memory/claims'
import { checkMemoryInvariants, type InvariantViolation } from '@shared/memory/invariants'
import { sentenceNames, type LiteralName } from '@shared/memory/literal'
import { scanNames, type NameMention } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import { checkAnchors } from '@shared/memory/reproof'
import { splitSentences } from '@shared/memory/sentences'
import { EMPTY_DOC } from '@shared/tiptap'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { nameScanShared, type NameScanShared } from '../nameIndexer'
import { povOf } from '../sceneDetailStore'
import {
  attachClaims,
  invariantClaims,
  reanchorClaim,
  sceneClaims,
  setClaimsState
} from './claimStore'

/**
 * The `anchors` job (F-16.17; plan P2a §1.3): local and free, on the mention queue after every
 * save of a v2 scene (after its name scan). For the active draft's claims of the scene:
 * - each live claim's anchor is checked (`checkAnchors`): it holds, it re-proves for free (a
 *   literal claim, new paragraph and anchor), or it goes stale (dimmed until a reading);
 * - a claim waiting on a shared alias (`pending.kind = 'subject'` with its name span) attaches
 *   once the name scan settles that span to one of its candidates and its anchor still holds
 *   (P2a-D22);
 * - P0's invariants are checked for the scene; a live claim that breaks one is demoted to stale
 *   and the kind is reported for diagnostics (`memory.invariant.<kind>`, P2a-D19).
 * A scene with no claims costs one query. Nothing is sent anywhere.
 */

export interface AnchorsResult {
  /** Live claims looked at. */
  checked: number
  staled: string[]
  reproved: string[]
  attached: string[]
  /** Invariant violations found and healed (each claim demoted to stale). */
  violations: InvariantViolation['kind'][]
}

const NOTHING: AnchorsResult = {
  checked: 0,
  staled: [],
  reproved: [],
  attached: [],
  violations: []
}

/** The scene's paragraphs now (none for a node that is no longer a manuscript document). */
function paragraphsOf(db: TreeDb, nodeId: string): Paragraph[] {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  return row === undefined ? [] : passageParagraphs(documentJson(row) ?? EMPTY_DOC)
}

/** The waiting claim's record, when the scan now names its span as exactly one candidate. */
function settledSubject(claim: Claim, mentions: readonly NameMention[]): string | null {
  if (claim.pending?.kind !== 'subject' || claim.subjectText === null) return null
  const norm = normName(claim.subjectText)
  const owners = new Set(
    mentions
      .filter(
        (mention) =>
          mention.para === claim.para &&
          !mention.ambiguous &&
          normName(mention.text) === norm &&
          claim.pending?.kind === 'subject' &&
          claim.pending.candidates.includes(mention.recordId)
      )
      .map((mention) => mention.recordId)
  )
  const [only, ...rest] = [...owners]
  return only !== undefined && rest.length === 0 ? only : null
}

/**
 * Runs the job for one scene. `shared` is the name scan's roster (read once per pass by the
 * caller, or here).
 */
export function runAnchors(
  db: TreeDb,
  nodeId: string,
  now: Date,
  shared?: NameScanShared
): AnchorsResult {
  const draftId = currentDraftId(db)
  if (draftId === null) return NOTHING
  const claims = sceneClaims(db, nodeId, draftId)
  if (claims.length === 0) return NOTHING

  const paragraphs = paragraphsOf(db, nodeId)
  const texts = paragraphs.map((paragraph) => paragraph.text)
  const sentences = sceneSentences(texts)
  const present = new Set(sentences.map((sentence) => sentence.hash))
  let mentions: NameMention[] | null = null
  let roster: NameScanShared | null = shared ?? null
  const scan = (): { mentions: NameMention[]; roster: NameScanShared } => {
    roster ??= nameScanShared(db)
    mentions ??= scanNames(paragraphs, roster.index, {
      povRecordId: povOf(db, nodeId),
      notMention: roster.notMention
    })
    return { mentions, roster }
  }
  const names = (p: number, index: number): LiteralName[] => {
    const paragraph = paragraphs[p]
    const span = splitSentences(texts[p] ?? '')[index]
    if (paragraph === undefined || span === undefined) return []
    const found = scan()
    return sentenceNames(paragraph, span, found.mentions, (id) => found.roster.index.kinds.get(id))
  }

  const result: AnchorsResult = {
    checked: 0,
    staled: [],
    reproved: [],
    attached: [],
    violations: []
  }
  db.transaction((tx) => {
    const verdicts = checkAnchors(claims, { paragraphs: texts, sentences, names })
    result.checked = verdicts.length
    for (const verdict of verdicts) {
      if (verdict.verdict === 'stale') result.staled.push(verdict.id)
      if (verdict.verdict === 'reproved') {
        reanchorClaim(tx, verdict.id, { para: verdict.para, anchor: verdict.anchor }, now)
        result.reproved.push(verdict.id)
      }
    }
    setClaimsState(tx, result.staled, 'stale')

    const waiting = claims.filter(
      (each) =>
        each.state === 'waiting' && each.pending?.kind === 'subject' && each.subjectText !== null
    )
    for (const each of waiting) {
      const recordId = settledSubject(each, scan().mentions)
      if (recordId === null || !anchorHolds(each.anchor, present) || each.anchor.length === 0)
        continue
      attachClaims(tx, [each.id], recordId, now)
      result.attached.push(each.id)
    }

    // The invariants, over what is stored now: a live claim that breaks one is demoted.
    const live = new Set(
      sceneClaims(tx, nodeId, draftId)
        .filter((each) => each.state === 'live')
        .map((each) => each.id)
    )
    const violations = checkMemoryInvariants({
      claims: invariantClaims(tx, nodeId),
      sceneHashes: new Map([[nodeId, present]]),
      aliases: [],
      citations: []
    }).flatMap((violation) =>
      'claimId' in violation && live.has(violation.claimId) ? [violation] : []
    )
    setClaimsState(
      tx,
      [
        ...new Set(violations.map((violation) => ('claimId' in violation ? violation.claimId : '')))
      ],
      'stale'
    )
    result.violations = violations.map((violation) => violation.kind)
  })
  return result
}
