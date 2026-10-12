import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { anchorInPlace, sceneSentences } from '@shared/memory/anchor'
import type { Claim } from '@shared/memory/claims'
import { checkMemoryInvariants, type InvariantViolation } from '@shared/memory/invariants'
import { sentenceNames, type LiteralName } from '@shared/memory/literal'
import { scanNames, type NameMention } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import { cardParas, checkAnchors } from '@shared/memory/reproof'
import { splitSentences } from '@shared/memory/sentences'
import { readerMayRead } from '@shared/memory/sources'
import { EMPTY_DOC } from '@shared/tiptap'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../../voice/profile'
import { nameScanShared, type NameScanShared } from '../nameIndexer'
import { povOf } from '../sceneDetailStore'
import { getCard, moveCardParas } from './cardStore'
import {
  attachClaims,
  claimSources,
  invariantClaims,
  reanchorClaim,
  restoreClaim,
  sceneClaims,
  setClaimPara,
  setClaimsState
} from './claimStore'

/**
 * The `anchors` job (F-16.17; plan P2a §1.3): local and free, on the mention queue after every
 * save of a v2 scene (after its name scan), and when a scene's Idea status or compile inclusion
 * changes. For the active draft's claims of the scene:
 * - a scene that is not readable (an Idea, left out of compile, moved out of the manuscript) has
 *   its live claims parked as stale: it is never real (design §2.2). That is the author's doing,
 *   not a fault, so it is not counted; they come back below once the scene is readable again;
 * - each live claim's anchor is checked in place (`checkAnchors`): it holds (following its quote
 *   when paragraphs above it came or went), it re-proves for free (a literal claim, new paragraph
 *   and anchor), or it goes stale (dimmed until a reading);
 * - a stale claim whose anchor holds in place again (an edit undone, the renamed text saved) is
 *   restored: the very sentences that proved it are back, so nothing needs reading;
 * - a claim waiting on its subject goes stale when its sentences change (a reading over them then
 *   drops it and proposes it again), and one waiting on a shared alias attaches once the name scan
 *   settles that span to one of its candidates (P2a-D22);
 * - the card's quotes follow their paragraphs too;
 * - P0's invariants are checked for the scene; a live claim that breaks one is demoted to stale
 *   and the kind is reported for diagnostics (`memory.invariant.<kind>`, P2a-D19).
 * A scene with no claims costs one query. Nothing is sent anywhere.
 */

export interface AnchorsResult {
  /** Claims judged (live, waiting on a subject, and stale ones whose anchor holds again). */
  checked: number
  staled: string[]
  reproved: string[]
  restored: string[]
  attached: string[]
  /** Live claims parked as stale because their scene is not readable (not a fault, not counted). */
  parked: string[]
  /** Invariant violations found and healed (each claim demoted to stale). */
  violations: InvariantViolation['kind'][]
}

const nothing = (): AnchorsResult => ({
  checked: 0,
  staled: [],
  reproved: [],
  restored: [],
  attached: [],
  parked: [],
  violations: []
})

/** The scene's paragraphs now (none for a node that is no longer a manuscript document). */
function paragraphsOf(db: TreeDb, nodeId: string): Paragraph[] {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  return row === undefined ? [] : passageParagraphs(documentJson(row) ?? EMPTY_DOC)
}

/** The waiting claim's record, when the scan now names its span as exactly one candidate. */
function settledSubject(
  claim: Claim,
  para: number,
  mentions: readonly NameMention[]
): string | null {
  if (claim.pending?.kind !== 'subject' || claim.subjectText === null) return null
  const norm = normName(claim.subjectText)
  const candidates = claim.pending.candidates
  const owners = new Set(
    mentions
      .filter(
        (mention) =>
          mention.para === para &&
          !mention.ambiguous &&
          normName(mention.text) === norm &&
          candidates.includes(mention.recordId)
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
  if (draftId === null) return nothing()
  const claims = sceneClaims(db, nodeId, draftId)
  const card = getCard(db, nodeId, draftId)
  if (claims.length === 0 && card === null) return nothing()

  const result = nothing()
  if (!readerMayRead(claimSources(db)(nodeId))) {
    result.parked = claims.filter((each) => each.state === 'live').map((each) => each.id)
    setClaimsState(db, result.parked, 'stale')
    return result
  }

  const paragraphs = paragraphsOf(db, nodeId)
  const texts = paragraphs.map((paragraph) => paragraph.text)
  const sentences = sceneSentences(texts)
  const hashes = sentences.map((sentence) => sentence.hash)
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

  db.transaction((tx) => {
    const verdicts = checkAnchors(claims, { paragraphs: texts, sentences, names })
    result.checked = verdicts.length
    const byId = new Map(claims.map((each) => [each.id, each]))
    /** Each claim's paragraph after the verdicts. */
    const paraNow = new Map(claims.map((each) => [each.id, each.para]))
    for (const verdict of verdicts) {
      switch (verdict.verdict) {
        case 'holds':
          break
        case 'moved':
          setClaimPara(tx, verdict.id, verdict.para)
          paraNow.set(verdict.id, verdict.para)
          break
        case 'reproved':
          reanchorClaim(tx, verdict.id, { para: verdict.para, anchor: verdict.anchor }, now)
          result.reproved.push(verdict.id)
          break
        case 'stale':
          result.staled.push(verdict.id)
          break
        case 'restored': {
          const claim = byId.get(verdict.id)
          const waits = claim?.pending?.kind === 'subject'
          // A claim with neither a record nor a subject to wait on stays stale (a reading drops it).
          if (claim === undefined || (claim.recordId === null && !waits)) break
          restoreClaim(tx, verdict.id, verdict.para, waits ? 'waiting' : 'live')
          paraNow.set(verdict.id, verdict.para)
          result.restored.push(verdict.id)
          break
        }
      }
    }
    setClaimsState(tx, result.staled, 'stale')

    const staled = new Set(result.staled)
    const restored = new Set(result.restored)
    const waiting = claims.filter(
      (each) =>
        (each.state === 'waiting' || restored.has(each.id)) &&
        !staled.has(each.id) &&
        each.pending?.kind === 'subject' &&
        each.subjectText !== null
    )
    for (const each of waiting) {
      const recordId = settledSubject(each, paraNow.get(each.id) ?? each.para, scan().mentions)
      if (recordId === null || !anchorInPlace(each.anchor, hashes)) continue
      attachClaims(tx, [each.id], recordId, now)
      result.attached.push(each.id)
    }

    if (card !== null) {
      const moved = cardParas(card, texts)
      if (moved !== null) moveCardParas(tx, nodeId, draftId, moved)
    }

    // The invariants, over what is stored now: a live claim that breaks one is demoted.
    const live = new Set(
      sceneClaims(tx, nodeId, draftId)
        .filter((each) => each.state === 'live')
        .map((each) => each.id)
    )
    const violations = checkMemoryInvariants({
      claims: invariantClaims(tx, nodeId),
      sceneHashes: new Map([[nodeId, new Set(hashes)]]),
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
