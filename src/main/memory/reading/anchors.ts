import { passageParagraphs, type Paragraph } from '@shared/mentions'
import { anchorInPlace, sceneSentences } from '@shared/memory/anchor'
import { CARD_FIELDS, type Card, type Claim } from '@shared/memory/claims'
import { gateSentences, readSetOf, unreadSentences } from '@shared/memory/gate'
import { checkMemoryInvariants, type InvariantViolation } from '@shared/memory/invariants'
import { sentenceNames, type LiteralName } from '@shared/memory/literal'
import { scanNames, type NameMention } from '@shared/memory/nameScan'
import { normName } from '@shared/memory/names'
import { cardParas, cardStanding, checkAnchors, type ReproofClaim } from '@shared/memory/reproof'
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
  invariantKnows,
  reanchorClaim,
  restoreClaim,
  sceneClaims,
  setClaimPara,
  setClaimsState
} from './claimStore'
import { getSceneRead, setSceneSettled } from './sceneReadStore'
import {
  restoreTopicQuote,
  sceneTopicQuotes,
  setTopicQuotePara,
  setTopicQuotesState,
  type TopicQuote
} from './topicStore'

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
 *   and the kind is reported for diagnostics (`memory.invariant.<kind>`, P2a-D19);
 * - P2b: the secrets' and threads' reveals (`topic_quote`) get the claims' treatment: they hold,
 *   move, go stale or are restored (never re-proved for free: a reveal is never literal), and are
 *   parked with the claims in a scene that is not readable; and a save that leaves a finished
 *   sentence unread clears the scene's `settled` flag ("checked up to" stops before it, P2b-D9).
 * A scene with no claims, reveals or settled flag costs a few queries. Nothing is sent anywhere.
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
  /** The records whose lines changed state (what a shown sheet reads again); topics included. */
  recordIds: string[]
  /** P2b: reveals whose state changed (stale, restored or parked). */
  topicQuotes: string[]
  /** P2b-D9: the save left a finished sentence unread, so the scene is no longer settled. */
  unsettled: boolean
  /**
   * What of the scene's card stands on the text changed since the scene was last checked (a field
   * or someone on the page went stale or came back, or its quotes moved paragraph): the views read
   * its fields against the text as it is now (`heldCard`), so they are read again. An edit that
   * leaves the card as it stood moves nothing (review of P2b slice 5: the Timeline and the sheets
   * are not read again after every pause in typing).
   */
  card: boolean
}

/** Each scene's card as it last stood on the text (`standingKey`), by project, draft and scene. */
const lastStanding = new WeakMap<TreeDb, Map<string, string>>()

/** What of a card stands on the text: its fields and who is on the page; "parked" when unreadable. */
function standingKey(card: Card, texts: readonly string[] | null): string {
  if (texts === null) return 'parked'
  const held = cardStanding(card, texts)
  return JSON.stringify([
    CARD_FIELDS.filter((name) => held.fields[name] !== null),
    held.present.map((entry) => entry.recordId)
  ])
}

/** Records the card's standing and answers whether it moved since the scene was last checked. */
function standingMoved(db: TreeDb, key: string, standing: string): boolean {
  let known = lastStanding.get(db)
  if (known === undefined) {
    known = new Map()
    lastStanding.set(db, known)
  }
  const was = known.get(key)
  known.set(key, standing)
  return was !== standing
}

const nothing = (): AnchorsResult => ({
  checked: 0,
  staled: [],
  reproved: [],
  restored: [],
  attached: [],
  parked: [],
  violations: [],
  recordIds: [],
  topicQuotes: [],
  unsettled: false,
  card: false
})

/** Whether the run changed anything a view shows. */
export function anchorsChanged(result: AnchorsResult): boolean {
  return (
    result.staled.length +
      result.reproved.length +
      result.restored.length +
      result.attached.length +
      result.parked.length +
      result.violations.length +
      result.topicQuotes.length >
      0 || result.unsettled
  )
}

/** A reveal as the anchor verdicts read it: a verified line (never re-proved for free). */
const asReproof = (quote: TopicQuote): ReproofClaim => ({
  id: quote.id,
  proof: 'verified',
  state: quote.state,
  pending: null,
  anchor: quote.anchor,
  quote: quote.quote,
  para: quote.para,
  recordId: quote.recordId,
  slot: 'knows',
  value: quote.label,
  objectId: null,
  voice: 'narration',
  mode: 'now'
})

/** The scene's paragraphs now (none for a node that is no longer a manuscript document). */
export function paragraphsOf(db: TreeDb, nodeId: string): Paragraph[] {
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
  const quotes = sceneTopicQuotes(db, nodeId, draftId)
  const read = getSceneRead(db, nodeId, draftId)
  if (claims.length === 0 && card === null && quotes.length === 0 && read?.settled !== true) {
    return nothing()
  }

  const result = nothing()
  const standingAt = `${draftId}|${nodeId}`
  const recordsOf = (ids: readonly string[]): string[] => {
    const wanted = new Set(ids)
    return claims.flatMap((each) => {
      if (!wanted.has(each.id)) return []
      // A knows line's secret shows it too (P2b).
      return [each.recordId, each.slot === 'knows' ? each.objectId : null].filter(
        (id): id is string => id !== null
      )
    })
  }
  const topicsOf = (ids: readonly string[]): string[] =>
    quotes.filter((quote) => ids.includes(quote.id)).map((quote) => quote.recordId)
  if (!readerMayRead(claimSources(db)(nodeId))) {
    result.card = card !== null && standingMoved(db, standingAt, standingKey(card, null))
    result.parked = claims.filter((each) => each.state === 'live').map((each) => each.id)
    setClaimsState(db, result.parked, 'stale')
    result.topicQuotes = quotes.filter((quote) => quote.state === 'live').map((quote) => quote.id)
    setTopicQuotesState(db, result.topicQuotes, 'stale')
    result.recordIds = [...new Set([...recordsOf(result.parked), ...topicsOf(result.topicQuotes)])]
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
      const standing = standingMoved(db, standingAt, standingKey(card, texts))
      result.card = standing || moved !== null
    }

    // P2b: the reveals follow their sentences like claims, with no free re-proof.
    const staledQuotes: string[] = []
    for (const verdict of checkAnchors(quotes.map(asReproof), {
      paragraphs: texts,
      sentences,
      names
    })) {
      switch (verdict.verdict) {
        case 'moved':
          setTopicQuotePara(tx, verdict.id, verdict.para)
          break
        case 'stale':
          staledQuotes.push(verdict.id)
          break
        case 'restored':
          restoreTopicQuote(tx, verdict.id, verdict.para)
          result.topicQuotes.push(verdict.id)
          break
        case 'holds':
        case 'reproved':
          break
      }
    }
    setTopicQuotesState(tx, staledQuotes, 'stale')
    result.topicQuotes.push(...staledQuotes)

    // P2b-D9: a finished sentence the save left unread means the scene is no longer settled.
    if (read?.settled === true) {
      const index = scan().roster.index
      const current = gateSentences(texts, { caretPara: null, names: index })
      if (unreadSentences(current, readSetOf(read.entries, index)).length > 0) {
        result.unsettled = setSceneSettled(tx, nodeId, draftId, false)
      }
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
      citations: [],
      knows: invariantKnows(tx, nodeId)
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
  const attachedTo = sceneClaims(db, nodeId, draftId).flatMap((each) =>
    result.attached.includes(each.id) && each.recordId !== null ? [each.recordId] : []
  )
  result.recordIds = [
    ...new Set([
      ...recordsOf([...result.staled, ...result.reproved, ...result.restored]),
      ...attachedTo,
      ...topicsOf(result.topicQuotes)
    ])
  ]
  return result
}
