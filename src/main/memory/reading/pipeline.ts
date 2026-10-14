import { estimateTokens } from '@shared/ai'
import { anchorFor, sceneSentences } from '@shared/memory/anchor'
import {
  CARD_GIST_MAX_WORDS,
  CARD_LINE_MAX_WORDS,
  emptyCardFields,
  emptyYields,
  valueKey,
  type Card,
  type CardField,
  type CardFields,
  type CardPresent,
  type Claim,
  type ClaimMode,
  type ClaimPending,
  type ClaimProof,
  type ClaimVoice,
  type ParaRange,
  type ReadingPurpose,
  type ReadingYields,
  type SpotVerdict
} from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import {
  gateSentences,
  gateText,
  nextReadSet,
  readDecision,
  readSetOf,
  unreadSentences,
  type GateSentence,
  type KnownWords,
  type ReadDecision,
  type ReadSentence
} from '@shared/memory/gate'
import { KNOWER_KINDS, keepsFrom, parseHow } from '@shared/memory/knows'
import {
  ANTECEDENT_SENTENCES,
  groupHeadIn,
  nameInSentence,
  quotePointsAtSubject,
  resolveSubject,
  valueStated,
  wishWord,
  type LadderReject,
  type LadderSentence,
  type SubjectResult
} from '@shared/memory/ladder'
import { literalProof, type LiteralName } from '@shared/memory/literal'
import { nameAsker, nameSpans } from '@shared/memory/nameQuestions'
import { normName } from '@shared/memory/names'
import { locateQuote, type QuoteLocation } from '@shared/memory/quote'
import {
  parseReaderAnswer,
  parseVerifyAnswer,
  type ReaderAnswer,
  type ReaderCard,
  type ReaderCardField,
  type ReaderClaim,
  type VerifyVerdict
} from '@shared/memory/readerAnswer'
import { reconcile, type FreshClaim } from '@shared/memory/reconcile'
import { OBJECT_SLOTS, readSlot, slotFitsKind, slotGroup, type Slot } from '@shared/memory/slots'
import { readerMayRead } from '@shared/memory/sources'
import { spotPicked } from '@shared/memory/spot'
import {
  TOPIC_CAPS,
  parseStep,
  sameAsCandidates,
  topicLabel,
  type TopicFacet,
  type TopicKind
} from '@shared/memory/topics'
import { cardDue, planPages, planWindows, type ReadPiece } from '@shared/memory/windows'
import { activeDraftId, currentDraftId } from '../../draft/draftStore'
import { STEP_VALUE_MAX_WORDS } from '../../ai/prompts/reader.v2'
import {
  READER_V3_PROMPT_VERSION,
  buildReaderV3Prompt,
  readerV3OutputCap,
  readerV3PageTokens
} from '../../ai/prompts/reader.v3'
import { VERIFY_UNNAMED_MARK, verifyV2Batches, type VerifyV2Item } from '../../ai/prompts/verify.v2'
import { VERIFY_V3_PROMPT_VERSION, buildVerifyV3Prompt } from '../../ai/prompts/verify.v3'
import { cancelInflight } from '../../ai/inflight'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from '../../ai/request'
import { AiCancelledError, type AiMessage } from '../../ai/providers/types'
import type { TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import {
  dismissedNames,
  getRecord,
  listRecords,
  pruneTopics,
  rosterOf,
  topicLabels
} from '../recordStore'
import { paragraphsOf, runAnchors } from './anchors'
import { getCard, upsertCard } from './cardStore'
import {
  claimSources,
  deleteClaims,
  draftClaims,
  insertClaims,
  reviveClaim,
  sceneClaims,
  setClaimSpot,
  type NewClaim
} from './claimStore'
import {
  anchoredLine,
  cardLine,
  loadReadingScene,
  namingParas,
  nearLines,
  positionLine,
  readBook,
  revealLine,
  typedLine,
  type Book,
  type ReadingScene
} from './readerContext'
import { notAboutMovedTo } from './readerRows'
import { insertReading } from './readingStore'
import { readerRoster, type ReaderRoster } from './rosterCache'
import { getSceneRead, setSceneSettled, writeSceneRead } from './sceneReadStore'
import { topicContext, type TopicContext } from './topicContext'
import {
  createTopic,
  deleteTopicQuotes,
  mergeInto,
  reviveTopicQuote,
  sceneTopicQuotes,
  type NewTopicQuote
} from './topicStore'
import { heldCard, hereChips, readingOrder } from './readingFrame'

/**
 * The reading pipeline (F-16.17, F-16.16's gate; design §2.3, plan P2a §2.4): `runReading` reads
 * one scene of the active draft when the gate says something changed, and keeps only what the
 * prose is proved to state.
 *
 * 1. **Gate** (`readDecision`): nothing unread, or only cosmetic edits → nothing is sent.
 * 2. **Plan**: the window (changed paragraphs ±2, back to a naming paragraph) or the whole scene
 *    in pages; whether the card is due.
 * 3. **Prompt** (`reader.v2`; `reader.v1` before P2b): the cached rosters, the scene's head, the
 *    facts known near the window and anchored in it, the numbered paragraphs; the context hash
 *    covers every message, so an identical request answers from the local cache (token rule 4).
 * 4. **Request** through `runAiRequest` (feature `reader`, fast, JSON, reasoning off): the daily
 *    cap, the budgets and the ledger are the request path's. A reply cut off at its cap is read
 *    to its last complete item and the paragraphs after the last one it quoted are read once more
 *    (the whole piece when it listed its facts out of paragraph order). A piece whose reply does
 *    not parse stays unread: nothing in it is treated as read.
 * 5. **Ladder**, per item: presence (the quote once in the window, in its paragraph), subject
 *    (`resolveSubject`: a name pins it, a pronoun goes to the checker with every character named
 *    in reach, first person only to the speaker or the typed POV), literal proof in code, then
 *    `verify.v2` (batches per page, each sized so its verdicts fit; a batch cut off at its cap has
 *    its unanswered items asked once more) for the rest, the card's POV, year and flashback, and
 *    who is on the page. Only what is proved is kept; every rejection is counted by reason in the
 *    reading's yields, and a fact the checker never answered leaves its paragraph unread.
 * 6. **Reconcile** (`reconcile.ts`) and write, in one transaction: the reading row (cost = reader
 *    + verify), the claims, the card, the read set. The scene is loaded again first: when an edit
 *    was saved, or the scene became unreadable, while the requests were out, the anchors job runs
 *    over what was written, so nothing anchored to sentences that are gone stays live.
 * 7. **New names** go through the twin gate: a name the author will be asked about
 *    (`nameAsker`, standing capitalised mid-sentence in its paragraph) keeps its proved facts
 *    `waiting` on the name (P2a-D7: no record is made silently); any other is dropped with them.
 *    A name two records share waits on their scan, like a shared alias in a fact's sentence.
 *
 * Nothing is read from a scene the reader may not read (an Idea, one left out of compile, outside
 * the manuscript), nor from another draft. Provider failures propagate and nothing is written.
 *
 * **P2b** (F-16.22, F-16.23; plan P2b §2.4): `reader.v2` and `verify.v2`. The reader also sees the
 * topics roster (secrets and threads) and the topic lines of the listed ones the window touches;
 * it answers knows facts, thread steps and new secrets and threads. Before the checker: a new
 * topic's revealing sentence must stand in the window (`topic`), one the author dismissed drops
 * silently with its facts, past the page's caps (3 secrets, 2 threads) the rest drop
 * (`topicCap`), and two new ones of one reading with the same label fold into one. A knows fact's
 * learner goes through the subject rules (a group only when its sentence names it, `group`;
 * never waiting), and must be Here or the POV: in code from the typed details, the held card and
 * this reading's verified card, else one on-page check in the same batch (`notHere` when it
 * fails). The checker's batch adds knows items (learner, how, source), step items, a Reveals item
 * per new topic or restated reveal, and up to 3 Same items per new topic (`sameAsCandidates`).
 * After the verdicts a new topic whose reveal holds is created silently (a verified reveal is
 * itself the proved claim that backs it, P2b-D3) or merged into the first open topic judged the
 * same (a `merged` reveal, its facts tagged, P2b-D4); a restated reveal revives its re-checking
 * one; re-checking reveals the reading read and did not revive go; then AI topics nothing backs
 * are pruned. The scene's read flags say a topic reader read it, and whether nothing finished is
 * left unread (P2b-D9). Knows lines and steps never take literal proof.
 */

export interface ReadingDeps {
  ai: AiRequestDeps
}

export interface RunReadingInput {
  nodeId: string
  /** The idle trigger's caret paragraph (P2a-D6); null for leave, Read now and the backlog. */
  caretPara: number | null
  /** The caller's id for `ai:cancel`; each request registers under `<requestId>:r<n>` / `:v<n>`. */
  requestId: string
  signal?: AbortSignal
  /**
   * Not a plain reading (slice 3): `rebuild` reads the whole scene whatever the gate says and
   * replaces the claims it does not prove again (P2a-D25); `backfill` reads `paras` (the
   * paragraphs naming a late name) ±2 whatever the gate says; `probe` is a reading the health gate
   * let through (one per 10 due scenes while paused), read as the gate says.
   */
  purpose?: Extract<ReadingPurpose, 'rebuild' | 'backfill' | 'probe'>
  /** A back-fill's paragraphs. */
  paras?: readonly number[]
  /**
   * After a rebuild has run, one new literal claim in this many (`spotPicked`) rides the page's
   * check batch as a fast spot check (P2a-D8); null (or absent) before any rebuild.
   */
  spotEvery?: number | null
  /** Told how each proposed fact ended (the eval's per-slot scoring); nothing in the app listens. */
  observe?: (event: ReadingItemEvent) => void
  /**
   * Each request's reported cost as it returns (the Cloud monthly tally), so a reading that fails
   * after its first request still counts what it spent.
   */
  onSpend?: (usd: number) => void
}

/** How one proposed fact ended: kept (literal, verified, waiting) or refused, and why. */
export interface ReadingItemEvent {
  outcome: 'literal' | 'verified' | 'waiting' | LadderReject
  /** The slot as proposed. */
  slot: string
  /** The record the reader proposed (null for a fact about a new name). */
  recordId: string | null
  name: string | null
  p: number
  quote: string
  /** What was stored: the subject (null while it waits), voice and mode. */
  stored: { recordId: string | null; voice: ClaimVoice; mode: ClaimMode } | null
}

export type ReadingSkip = 'empty' | 'upToDate' | 'cosmetic' | 'notReadable'

export type ReadingOutcome =
  | { read: false; reason: ReadingSkip }
  /** A local model answered empty at its cap: reading pauses (slice 3), nothing was stored. */
  | { read: false; reason: 'localCutoff'; model: string; costUsd: number }
  | {
      read: true
      readingId: string
      purpose: ReadingPurpose
      pages: number
      costUsd: number
      /** A page was cut off at its cap (the reading's `finish_reason` is `length`). */
      cut: boolean
      yields: ReadingYields
      /** The records whose claims or card presence this reading changed. */
      recordIds: string[]
      /** The new names (norms) this reading left facts waiting on. */
      names: string[]
      /** The claims this reading stored (not the revived ones), for the spot checks. */
      inserted: { id: string; proof: ClaimProof }[]
      /** The model that read. */
      model: string
      /**
       * F-16.21: whether the reading wrote a card whose line differs from the one before (or the
       * scene's first card): only then may plan links ask `planLinks.v2`.
       */
      lineMoved: boolean
      /**
       * P2b: the secrets and threads this reading made, merged a reveal into, revived, lost a
       * reveal of, or pruned (`record:changed`, so the sidebar's lists update).
       */
      topicIds: string[]
    }

/** A reading's running totals over its requests. */
interface Spend {
  model: string
  tokensIn: number
  tokensOut: number
  reasoning: number
  costUsd: number
  cloud: boolean
  verifySent: boolean
}

class LocalCutoff extends Error {
  constructor(readonly model: string) {
    super('The local model answered empty at its cap.')
  }
}

function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiCancelledError('Reading the scene was stopped.')
}

/** One request through the request path, its child id registered for `ai:cancel`. */
async function send(
  deps: ReadingDeps,
  input: RunReadingInput,
  spend: Spend,
  inFlight: { id: string | null },
  request: {
    feature: 'reader' | 'verify'
    messages: AiMessage[]
    maxTokens: number
    childId: string
    promptVersion: typeof READER_V3_PROMPT_VERSION | typeof VERIFY_V3_PROMPT_VERSION
  }
): Promise<AiRequestResult> {
  stopIfCancelled(input.signal)
  inFlight.id = request.childId
  try {
    const result = await runAiRequest(deps.ai, {
      feature: request.feature,
      tier: 'fast',
      messages: request.messages,
      maxTokens: request.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(request.messages)),
      promptVersion: request.promptVersion,
      requestId: request.childId,
      // A reply that does not parse is not kept, so the next reading asks again.
      cacheIf:
        request.feature === 'reader'
          ? (text) => parseReaderAnswer(text) !== null
          : (text) => parseVerifyAnswer(text).size > 0
    })
    if (spend.model === '') spend.model = result.model
    spend.tokensIn += result.usage.inputTokens
    spend.tokensOut += result.usage.outputTokens
    spend.reasoning += result.usage.reasoningTokens ?? 0
    spend.costUsd += result.costUsd
    input.onSpend?.(result.costUsd)
    if (request.feature === 'verify') spend.verifySent = true
    const local = deps.ai.providers.get()?.id === 'local'
    if (local && result.text.trim() === '' && result.finishReason === 'length') {
      throw new LocalCutoff(result.model)
    }
    return result
  } finally {
    inFlight.id = null
  }
}

/** P2b: a knows line's secret or a thread step's thread: a listed one, or one new in this reading. */
type TopicRef = { kind: 'listed'; recordId: string } | { kind: 'new'; key: string }

/** What a proposed item is: a fact (P2a), a knows line or a thread step (P2b). */
type ItemKind = 'fact' | 'knows' | 'step'

/** The ladder's work on one proposed fact. */
interface Item {
  /** Where it came from: the piece and the paragraph texts sent with it. */
  piece: number
  claim: ReaderClaim
  kind: ItemKind
  slot: Slot
  /** The record it is about (null for a fact about a new name). */
  recordId: string | null
  /** The new name it is about. */
  name: { norm: string; text: string } | null
  objectId: string | null
  speakerId: string | null
  /** P2b: a knows line's secret or a step's thread. */
  topic: TopicRef | null
  /** P2b: the reader's how (a knows how, a thread step). */
  how: string | null
  /** P2b: the reader's source of a told, overheard or read line. */
  fromId: string | null
  location: QuoteLocation
  quote: LadderSentence[]
  /** A step's subject is its thread (`topic`): no name needed. */
  subject: SubjectResult | { kind: 'newName'; text: string } | { kind: 'topic' }
  proof: 'literal' | null
  /** A literal claim picked for a fast spot check: its check's index. */
  spotCheck: number | null
  value: string
  /** The verify item for it, when one was sent. */
  check: number | null
}

/** P2b: a secret or thread the reader proposed as new, followed through the checker. */
interface NewTopic {
  /** `<piece>:<the reader's id>`: the reader's ids are its own per reply. */
  key: string
  piece: number
  id: string
  kind: TopicKind
  label: string
  p: number
  q: string
  /** Where its revealing sentence stands (null when it does not, `topic`). */
  location: QuoteLocation | null
  /** The gate texts of its sentences: its Dismissed key's input, kept on its reveal. */
  stating: string[]
  /** Folded into another new topic of this reading with the same label (its key). */
  into: string | null
  /**
   * Why it was dropped: its sentence not found or its reveal refused (`topic`), past the caps, a
   * reveal the author dismissed, a check with no verdict (`unanswered`, read again), or a secret
   * the text only gives as a rumour, a hypothetical or a dream (`notCounted`, P2b-D7).
   */
  dropped: 'topic' | 'topicCap' | 'dismissed' | 'unanswered' | 'notCounted' | null
  /** Its Reveals check. */
  reveal: number | null
  /** Its Same checks, highest overlap first. */
  same: { target: TopicRef; check: number }[]
  /**
   * What it merges into once the checker judged them the same (P2b-D4): an open topic, or a new
   * one an earlier page of this reading made (its key; review of P2b slice 2).
   */
  mergeInto: TopicRef | null
}

/** P2b: a listed topic's re-checking reveal the reader stated again. */
interface Restated {
  recordId: string
  kind: TopicKind
  piece: number
  p: number
  q: string
  location: QuoteLocation
  stating: string[]
  /** The re-checking reveal it would revive. */
  quoteId: string
  check: number | null
}

/** The gate texts of a located quote's sentences (a reveal's `stating`, a Dismissed key's input). */
function statingOf(
  scene: ReadingScene,
  p: number,
  location: QuoteLocation,
  names: ReadingScene['shared']['index']
): string[] {
  return location.sentences.map((i) => gateText(scene.spans[p]?.[i]?.text ?? '', names))
}

/** A verify item, with what it checks. */
interface Check extends VerifyV2Item {
  piece: number
  /** The item, card field or present entry it checks. */
  target:
    | {
        kind: 'item'
        index: number
        expect: string | null
        candidates: string[]
        /** A knows item's source candidates (record ids). */
        from: string[]
      }
    | { kind: 'card'; field: 'pov' | 'year' | 'flashback' }
    | { kind: 'present'; index: number }
    /** A literal claim's fast spot check (P2a-D8): counted, never refusing the claim. */
    | { kind: 'spot'; index: number; expect: string }
    /** P2b-D8: a knows line's learner shown on the page (one check per learner and page). */
    | { kind: 'here'; recordId: string }
    /** P2b-D3: a new topic's revealing sentence. */
    | { kind: 'reveal'; key: string }
    /** A listed topic's re-checking reveal, stated again. */
    | { kind: 'restated'; index: number }
    /** P2b-D4: a new topic against an open one it may repeat. */
    | { kind: 'same'; key: string; with: TopicRef }
  /** Short ids the checker may answer for a pronoun or a new name, to the record (or name) each means. */
  ids: Map<string, string>
}

/** A card field located in the window its piece sent and in its paragraph. */
interface PlacedField {
  field: ReaderCardField
  location: QuoteLocation
  /** The piece whose reply gave it (its checks ride that piece's batch). */
  piece: number
}

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean)

const capWords = (text: string, most: number): string => {
  const all = words(text)
  return all.length <= most ? text.trim() : `${all.slice(0, most).join(' ')}…`
}

/** The texts a piece sent, aligned with the scene's paragraphs (empty where nothing was sent). */
function sentTexts(scene: ReadingScene, piece: ReadPiece): string[] {
  const texts = scene.texts.map(() => '')
  for (const part of piece.paragraphs) {
    texts[part.p] = (scene.texts[part.p] ?? '').slice(part.start, part.end)
  }
  return texts
}

/** The sentence positions a piece sent whole. */
function sentPositions(scene: ReadingScene, piece: ReadPiece): Set<number> {
  const positions = new Set<number>()
  for (const part of piece.paragraphs) {
    for (const [index, span] of (scene.spans[part.p] ?? []).entries()) {
      if (span.start >= part.start && span.end <= part.end) {
        positions.add(scene.position(part.p, index))
      }
    }
  }
  return positions
}

/** The quote located in the window sent, then in its whole paragraph (for its sentences). */
function locate(
  scene: ReadingScene,
  sent: readonly string[],
  p: number,
  quote: string
): QuoteLocation | LadderReject {
  const inWindow = locateQuote(sent, p, quote)
  if (!inWindow.ok) return inWindow.reason
  const only = scene.texts.map((text, i) => (i === p ? text : ''))
  const whole = locateQuote(only, p, quote)
  return whole.ok ? whole : 'repeated'
}

/**
 * The sentences ±`around` (1 for the checker, 3 for a strong spot check) around positions
 * `from`..`to` (and from `naming` when it stands earlier).
 */
function contextText(
  scene: ReadingScene,
  from: number,
  to: number,
  naming?: number,
  around = 1
): string {
  const start = Math.max(0, Math.min(from - around, naming ?? from - around))
  const end = Math.min(scene.sentences.length - 1, to + around)
  const out: string[] = []
  for (let position = start; position <= end; position += 1) {
    out.push(scene.ladderSentence(position).text)
  }
  return out.join(' ')
}

/** "by r7" for a dialogue or thought line's speaker, else nothing. */
function byText(speakerId: string | null, voice: ClaimVoice, roster: ReaderRoster): string {
  return speakerId !== null && (voice === 'dialogue' || voice === 'thought')
    ? ` by ${roster.shortOf(speakerId)}`
    : ''
}

/**
 * A line as the checker reads it: a fact ("location: the quay (narration, now)"), a knows line
 * ("knows, overheard from r2 (narration, now)") or a thread step ("advances: she writes to him
 * (narration, now)").
 */
function lineText(
  line: {
    kind: ItemKind
    slot: string
    value: string
    objectId: string | null
    how: string | null
    fromId: string | null
    speakerId: string | null
    voice: ClaimVoice
    mode: ClaimMode
  },
  roster: ReaderRoster
): string {
  const voice = `(${line.voice}${byText(line.speakerId, line.voice, roster)}, ${line.mode})`
  if (line.kind === 'knows') {
    const from = line.fromId === null ? '' : ` from ${roster.shortOf(line.fromId)}`
    return `knows, ${line.how ?? line.value}${from} ${voice}`
  }
  if (line.kind === 'step') return `${line.how ?? ''}: ${line.value} ${voice}`
  const object = line.objectId === null ? '' : ` (of ${roster.shortOf(line.objectId)})`
  return `${line.slot}: ${line.value}${object} ${voice}`
}

/** What a stored claim is, by its slot. */
const claimKind = (claim: Pick<Claim, 'slot'>): ItemKind =>
  claim.slot === 'knows' ? 'knows' : claim.slot === 'thread' ? 'step' : 'fact'

/** The fact as the checker reads it, for a proposed item. */
function factText(item: Item, roster: ReaderRoster): string {
  return lineText(
    {
      kind: item.kind,
      slot: item.slot,
      value: item.value,
      objectId: item.objectId,
      how: item.how,
      fromId: item.fromId,
      speakerId: item.speakerId,
      voice: item.claim.voice,
      mode: item.claim.mode
    },
    roster
  )
}

/** How a checker item names the topic a stored knows line or step is about (`topicItemLines`). */
export interface TopicItemLines {
  itemLine(recordId: string): string
}

/** A stored claim as a spot check sends it: the checker's item, and what it must answer. */
export interface ClaimCheck extends VerifyV2Item {
  /** The short id the checker must answer as `r`; null for a thread step (its thread is fixed). */
  expect: string | null
  /** A knows line's how or a step, which the checker must answer too; null for a fact. */
  how: string | null
}

/** A stored claim's sentences, located again in its paragraph; null when its quote is gone. */
function claimSentences(
  scene: ReadingScene,
  claim: Claim
): { first: number; last: number; positions: number[] } | null {
  const only = scene.texts.map((text, i) => (i === claim.para ? text : ''))
  const location = locateQuote(only, claim.para, claim.quote)
  if (!location.ok) return null
  const positions = location.sentences.map((i) => scene.position(claim.para, i))
  return { first: Math.min(...positions), last: Math.max(...positions), positions }
}

/** A stored knows line's source candidates: its source, the speaker, everyone named ±1. */
function storedFromCandidates(
  scene: ReadingScene,
  claim: Claim,
  first: number,
  last: number
): string[] {
  const out: string[] = []
  const add = (id: string | null): void => {
    if (id === null || id === claim.recordId || out.includes(id)) return
    const kind = scene.kindOf(id)
    if (kind !== undefined && KNOWER_KINDS.includes(kind)) out.push(id)
  }
  add(claim.fromId)
  add(claim.speakerId)
  for (let position = Math.max(0, first - 1); position <= last + 1; position += 1) {
    for (const name of scene.ladderSentence(position).names) if (!name.ambiguous) add(name.recordId)
  }
  return out
}

/**
 * A stored claim as the checker reads it (the spot checks, F-16.17): its record's roster line,
 * the fact, and its quote's sentences ±`around`; null when its quote is no longer in its
 * paragraph (its anchor will say so) or it has no record yet. P2b: a knows line goes as a knows
 * item (its source candidates and its secret, `topics`), a thread step as a step item.
 */
export function claimCheck(
  scene: ReadingScene,
  claim: Claim,
  roster: ReaderRoster,
  around: number,
  topics?: TopicItemLines
): ClaimCheck | null {
  if (claim.recordId === null) return null
  const found = claimSentences(scene, claim)
  if (found === null) return null
  const kind = claimKind(claim)
  const text = contextText(scene, found.first, found.last, undefined, around)
  const fact = lineText({ ...claim, kind }, roster)
  if (kind === 'step') {
    return {
      kind: 'step',
      who: [],
      topic: topics?.itemLine(claim.recordId) ?? roster.topicShortOf(claim.recordId) ?? '?',
      fact,
      text,
      expect: null,
      how: claim.how
    }
  }
  if (kind === 'knows') {
    return {
      kind: 'knows',
      who: [roster.whoLine(claim.recordId)],
      from: storedFromCandidates(scene, claim, found.first, found.last).map((id) =>
        roster.whoLine(id)
      ),
      topic:
        claim.objectId === null
          ? '?'
          : (topics?.itemLine(claim.objectId) ?? roster.topicShortOf(claim.objectId) ?? '?'),
      fact,
      text,
      expect: roster.shortOf(claim.recordId),
      how: claim.how
    }
  }
  return {
    kind: 'claim',
    who: [roster.whoLine(claim.recordId)],
    fact,
    text,
    expect: roster.shortOf(claim.recordId),
    how: null
  }
}

/** *Not about*'s check: the checker's item, the short id it must answer, and every candidate's. */
export interface NotAboutCheck {
  item: VerifyV2Item
  expect: string
  /** A knows line's how, which the checker must answer too; null for a fact. */
  how: string | null
  /** A knows line's source candidates (record ids) for the picked learner; empty for a fact. */
  from: string[]
}

/** The on-page fact a present or Here check asks (P2a's card entries, P2b-D8's learners). */
export const onPageFact = (roster: ReaderRoster, recordId: string): string =>
  `${roster.shortOf(recordId)} is on the page in this scene (present, not only named or remembered)`

/**
 * P2b-D8: the on-page check of a learner for a stored knows line, on its quote's sentences ±1 (*Not
 * about* moving the line to a character not Here); null when the quote is gone.
 */
export function hereCheck(
  scene: ReadingScene,
  claim: Claim,
  recordId: string,
  roster: ReaderRoster
): VerifyV2Item | null {
  const found = claimSentences(scene, claim)
  if (found === null) return null
  return {
    kind: 'present',
    who: [roster.whoLine(recordId)],
    fact: onPageFact(roster, recordId),
    text: contextText(scene, found.first, found.last)
  }
}

/**
 * A stored claim as *Not right › Not about* sends it (F-16.18): the line checked for the record
 * the author picks, with the reading's subject safeguards (design §2.3 step 2). Every record named
 * for certain in the quote and in the `ANTECEDENT_SENTENCES` sentences before it (characters, the
 * picked record and the line's own) is a candidate, so the checker sees each rival a pronoun could
 * mean; the picked record joins them marked "not named here" when nothing in reach names it. The
 * text runs from the earliest naming sentence to `around` sentences after the quote. Null when the
 * quote is no longer in its paragraph (the line is stale: nothing can be checked), and for a
 * thread step (its subject is its thread, P2b). A knows line is re-checked as a knows item, its
 * secret named (`topics`).
 */
export function notAboutCheck(
  scene: ReadingScene,
  claim: Claim,
  pickedId: string,
  roster: ReaderRoster,
  around: number,
  topics?: TopicItemLines
): NotAboutCheck | null {
  const kind = claimKind(claim)
  if (kind === 'step') return null
  const found = claimSentences(scene, claim)
  if (found === null) return null
  const { first, last } = found
  const counts = (recordId: string): boolean =>
    recordId === pickedId || recordId === claim.recordId || scene.kindOf(recordId) === 'character'
  const named: string[] = []
  let naming: number | undefined
  const read = (position: number): void => {
    for (const name of scene.ladderSentence(position).names) {
      if (name.ambiguous || !counts(name.recordId)) continue
      if (!named.includes(name.recordId)) named.push(name.recordId)
      if (position < first) naming = Math.min(naming ?? position, position)
    }
  }
  for (const position of found.positions) read(position)
  for (
    let position = first - 1;
    position >= Math.max(0, first - ANTECEDENT_SENTENCES);
    position -= 1
  ) {
    read(position)
  }
  const unnamed = !named.includes(pickedId)
  const candidates = unnamed ? [...named, pickedId] : named
  const who = candidates.map((id) =>
    unnamed && id === pickedId ? `${roster.whoLine(id)}${VERIFY_UNNAMED_MARK}` : roster.whoLine(id)
  )
  const text = contextText(scene, first, last, naming, around)
  if (kind === 'knows') {
    // The source candidates for the picked learner: never the learner, whoever the line had.
    const from = storedFromCandidates(scene, { ...claim, recordId: pickedId }, first, last)
    return {
      item: {
        kind: 'knows',
        who,
        from: from.map((id) => roster.whoLine(id)),
        topic:
          claim.objectId === null
            ? '?'
            : (topics?.itemLine(claim.objectId) ?? roster.topicShortOf(claim.objectId) ?? '?'),
        // The line as it would read for the picked learner: its source only when still a candidate.
        fact: lineText(
          {
            ...claim,
            kind,
            fromId: claim.fromId !== null && from.includes(claim.fromId) ? claim.fromId : null
          },
          roster
        ),
        text
      },
      expect: roster.shortOf(pickedId),
      how: claim.how,
      from
    }
  }
  return {
    item: { kind: 'claim', who, fact: lineText({ ...claim, kind }, roster), text },
    expect: roster.shortOf(pickedId),
    how: null,
    from: []
  }
}

/**
 * Whether a verdict agrees with a line as stated: supported, about that record (any, for a thread
 * step: `expect` null), with its voice and mode, and, for a knows line or a step, its how.
 */
export function agrees(
  verdict: VerifyVerdict,
  fact: { expect: string | null; voice: ClaimVoice; mode: ClaimMode; how?: string | null }
): boolean {
  const how = fact.how ?? null
  const howAgrees =
    how === null ||
    (parseHow(how) !== null
      ? parseHow(verdict.how) === parseHow(how)
      : parseStep(verdict.how) !== null && parseStep(verdict.how) === parseStep(how))
  return (
    verdict.ok &&
    (fact.expect === null || verdict.r === fact.expect) &&
    verdict.voice === fact.voice &&
    verdict.mode === fact.mode &&
    howAgrees
  )
}

/**
 * The ids a reply's knows lines and steps point at that are neither listed (`listed`) nor given by
 * one of its own new secrets or threads: the part of the reply that gave them was cut off.
 */
function danglingTopicIds(answer: ReaderAnswer, listed: (id: string) => boolean): Set<string> {
  const given = new Set(
    answer.topics.filter((topic) => topic.label !== null).map((topic) => topic.id.trim())
  )
  const out = new Set<string>()
  for (const claim of answer.claims) {
    const id = claim.s === 'knows' ? claim.o : claim.s === 'thread' ? claim.r : null
    if (id !== null && !listed(id) && !given.has(id.trim())) out.add(id.trim())
  }
  return out
}

/** A reply without the knows lines and steps that point at `ids` in the paragraphs `at` says. */
function withoutLines(
  answer: ReaderAnswer,
  ids: ReadonlySet<string>,
  at: (p: number) => boolean
): ReaderAnswer {
  const points = (claim: ReaderClaim): boolean => {
    const id = claim.s === 'knows' ? claim.o : claim.s === 'thread' ? claim.r : null
    return id !== null && ids.has(id.trim()) && at(claim.p)
  }
  return { ...answer, claims: answer.claims.filter((claim) => !points(claim)) }
}

/**
 * A cut reply without what it gave from paragraph `from` on (facts, names, new secrets and
 * threads): that paragraph's list may stop midway, and the retry reads it again.
 */
function withoutFrom(answer: ReaderAnswer, from: number): ReaderAnswer {
  return {
    ...answer,
    claims: answer.claims.filter((claim) => claim.p < from),
    names: answer.names
      .filter((name) => name.p < from)
      .map((name) => ({ ...name, c: name.c.filter((claim) => claim.p < from) })),
    topics: answer.topics.filter((topic) => topic.p < from)
  }
}

/**
 * Merges two answers of one piece (a cut-off reply and a retry). Every id of the retry's that
 * is not a listed topic's is renamed (`x1` → `x1'`, `x1''` for a second retry), in its new
 * secrets and threads and in the
 * facts that use them, so the two replies' own ids never collide (a retry's line pointing at an id
 * it never gave stays unresolved, never the first reply's).
 */
function mergeAnswers(
  a: ReaderAnswer,
  b: ReaderAnswer,
  listed: (id: string) => boolean,
  suffix = "'"
): ReaderAnswer {
  const renamed = (id: string | null): string | null =>
    id !== null && !listed(id) ? `${id.trim()}${suffix}` : id
  return {
    claims: [
      ...a.claims,
      ...b.claims.map((claim) =>
        claim.s === 'knows'
          ? { ...claim, o: renamed(claim.o) }
          : claim.s === 'thread'
            ? { ...claim, r: renamed(claim.r) }
            : claim
      )
    ],
    names: [...a.names, ...b.names],
    topics: [
      ...a.topics,
      ...b.topics.map((topic) => ({ ...topic, id: renamed(topic.id) ?? topic.id }))
    ],
    same: [...a.same, ...b.same],
    drop: [...a.drop, ...b.drop],
    card: a.card ?? b.card,
    dropped: a.dropped + b.dropped,
    salvaged: a.salvaged || b.salvaged
  }
}

/** The last paragraph an answer quoted, or -1. */
function lastQuoted(answer: ReaderAnswer | null): number {
  if (answer === null) return -1
  return Math.max(
    -1,
    ...answer.claims.map((claim) => claim.p),
    ...answer.names.flatMap((name) => [name.p, ...name.c.map((claim) => claim.p)]),
    ...answer.topics.map((topic) => topic.p)
  )
}

/** Whether an answer listed its facts and its names each in paragraph order (as asked). */
function inOrder(answer: ReaderAnswer | null): boolean {
  if (answer === null) return true
  const rising = (ps: readonly number[]): boolean =>
    ps.every((p, i) => i === 0 || p >= (ps[i - 1] ?? p))
  return rising(answer.claims.map((claim) => claim.p)) && rising(answer.names.map((name) => name.p))
}

/** Where a cut-off reply's retry starts: after the last paragraph quoted, or over when out of order. */
const reachedOf = (answer: ReaderAnswer | null): number =>
  inOrder(answer) ? lastQuoted(answer) : -1

/**
 * Where a cut-off reply's retry starts (`reachedOf`), earlier when the reply was cut inside its
 * list of new names, secrets and threads (a knows line or step points at a new id it never gave):
 * that list is in paragraph order, so what it lost stands at or after the last one it gave (the
 * whole piece when it gave none). Review of P2b slice 2.
 */
function retryAfter(answer: ReaderAnswer | null, listed: (id: string) => boolean): number {
  const reached = reachedOf(answer)
  if (answer === null || danglingTopicIds(answer, listed).size === 0) return reached
  const lastNew = Math.max(
    -1,
    ...answer.names.map((name) => name.p),
    ...answer.topics.map((topic) => topic.p)
  )
  return Math.min(reached, lastNew - 1)
}

/** Paragraph ranges (inclusive) of a set of paragraphs. */
function ranges(paras: readonly number[]): ParaRange[] {
  const sorted = [...new Set(paras)].sort((a, b) => a - b)
  const out: ParaRange[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && p === last[1] + 1) last[1] = p
    else out.push([p, p])
  }
  return out
}

/** One scene of the active draft as the reading gate reads it, and the gate's answer (F-16.16). */
export interface SceneGate {
  scene: ReadingScene
  draftId: string
  /** Its finished sentences now (the caret paragraph left out on the idle trigger). */
  current: GateSentence[]
  /** What was read before, under today's roster; null when it never was in this draft. */
  readSet: ReadonlyMap<string, ReadSentence> | null
  stored: Claim[]
  card: Card | null
  decision: ReadDecision
}

/**
 * The reading gate over one scene (design §2.3 "When"): the pipeline's first step, and what the
 * reader service asks before it queues a reading (leave, idle, the backlog). Local. Null when the
 * reader may not read the scene (an Idea, left out of compile, not in the manuscript). When it
 * finds nothing finished unread (or only a cosmetic edit) in a scene read before, it marks the
 * scene settled (P2b-D9), the one write it makes.
 */
export function gateScene(
  db: TreeDb,
  nodeId: string,
  caretPara: number | null,
  book: Book = readBook(db)
): SceneGate | null {
  if (!readerMayRead(book.sourceOf(nodeId))) return null
  const scene = loadReadingScene(db, nodeId, book)
  if (scene === null) return null
  const draftId = activeDraftId(db)
  const names = scene.shared.index
  const current: GateSentence[] = gateSentences(scene.texts, { caretPara, names })
  const previous = getSceneRead(db, nodeId, draftId)
  const readSet = previous === null ? null : readSetOf(previous.entries, names)
  const stored = sceneClaims(db, nodeId, draftId)
  const card = getCard(db, nodeId, draftId)
  const present = new Set(scene.hashes)
  // A re-checking reveal (P2b) is read again like a re-checking fact.
  const staleReveals = sceneTopicQuotes(db, nodeId, draftId).filter((q) => q.state === 'stale')
  const staleParas = new Set([
    ...stored.filter((claim) => claim.state === 'stale').map((c) => c.para),
    ...staleReveals.map((quote) => quote.para)
  ])
  const cardStale = card?.anchor.some((hash) => !present.has(hash)) === true
  // The known words cost a pass over the manuscript: read only when an edit could be cosmetic.
  let known: KnownWords | null = null
  const decide = (sentences: readonly GateSentence[]): ReadDecision => {
    const unread = readSet === null ? [] : unreadSentences(sentences, readSet)
    return readDecision({
      sentences,
      read: readSet,
      partials: previous?.partials ?? 0,
      staleParas,
      cardStale,
      knownWords: unread.length > 0 ? (known ??= book.knownWords(nodeId)) : new Set<string>()
    })
  }
  const decision = decide(current)
  // P2b-D9: nothing finished is unread (or only cosmetically changed): the scene is settled. The
  // idle trigger leaves the caret paragraph out of what to read, never out of what is settled.
  if (decision.read === 'nothing' && decision.reason !== 'empty' && previous !== null) {
    const whole =
      caretPara === null ? decision : decide(gateSentences(scene.texts, { caretPara: null, names }))
    if (whole.read === 'nothing') setSceneSettled(db, nodeId, draftId, true)
  }
  return { scene, draftId, current, readSet, stored, card, decision }
}

/** Reads one scene (see the module comment). */
export async function runReading(
  db: TreeDb,
  deps: ReadingDeps,
  input: RunReadingInput
): Promise<ReadingOutcome> {
  const now = (): Date => deps.ai.now()

  // 1. The gate.
  const gate = gateScene(db, input.nodeId, input.caretPara)
  if (gate === null) return { read: false, reason: 'notReadable' }
  const { scene, draftId, current, readSet, stored, card, decision } = gate
  const names = scene.shared.index
  const present = new Set(scene.hashes)
  const rebuild = input.purpose === 'rebuild'
  const backfill = input.purpose === 'backfill'
  const backfillParas = backfill ? (input.paras ?? []).filter((p) => p < scene.texts.length) : []
  if (backfill) {
    if (current.length === 0 || backfillParas.length === 0) return { read: false, reason: 'empty' }
  } else if (decision.read === 'nothing' && !(rebuild && current.length > 0)) {
    return { read: false, reason: decision.reason }
  }
  const full = rebuild || (!backfill && decision.read === 'full')
  const purpose: ReadingPurpose = rebuild
    ? 'rebuild'
    : backfill
      ? 'backfill'
      : input.purpose === 'probe'
        ? 'probe'
        : decision.read === 'full'
          ? decision.reason === 'first'
            ? 'first'
            : 'full'
          : 'window'

  // 2. The plan. A topics roster past its share makes the pages smaller, so every request fits
  // its input cap (P2b-D10, amended in review).
  const roster = readerRoster(db)
  const pageTokens = readerV3PageTokens(roster.topicLines)
  const windowParas = backfill ? backfillParas : decision.read === 'window' ? decision.paras : []
  const pieces = full
    ? planPages(scene.texts, estimateTokens, pageTokens)
    : planWindows(scene.texts, windowParas, namingParas(scene), estimateTokens, pageTokens)
  if (pieces.length === 0) return { read: false, reason: 'empty' }
  const due = cardDue({ card, full, present, finished: current.map((s) => s.hash) })

  const order = readingOrder(db)
  const at = order.at.get(input.nodeId) ?? Number.MAX_SAFE_INTEGER
  const draft = draftClaims(db, draftId).filter(
    (claim) => (order.at.get(claim.nodeId) ?? Number.MAX_SAFE_INTEGER) <= at
  )
  // P2b: the records once, the secrets and threads as of the scene, and who is Here before the
  // reading (the typed details and the held card; this reading's verified card joins them later).
  const records = listRecords(db)
  const recordsById = new Map(records.map((record) => [record.id, record]))
  const topics: TopicContext = topicContext(db, {
    roster,
    records,
    draftId,
    order,
    nodeId: input.nodeId,
    claims: draft
  })
  const hereBefore = new Set(
    hereChips(scene.details, card === null ? null : heldCard(db, card, true), recordsById).map(
      (chip) => chip.recordId
    )
  )
  const storedReveals = sceneTopicQuotes(db, input.nodeId, draftId)
  /**
   * A reveal this reading checks again: a re-checking one, or, on a rebuild, every one (a rebuild
   * replaces what it does not prove again, the scene's secrets and threads included, P2a-D25).
   */
  const rechecks = (reveal: { state: string }): boolean => reveal.state === 'stale' || rebuild
  const yields = emptyYields()
  const reject = (reason: LadderReject | 'unparsed'): void => {
    yields.rejected += 1
    yields.rejections[reason] = (yields.rejections[reason] ?? 0) + 1
  }
  /** A count kept beside the rejections (P2b: topics made and merged), not a rejection. */
  const count = (key: string): void => {
    yields.rejections[key] = (yields.rejections[key] ?? 0) + 1
  }
  // P2b-D10 (amended): the roster left topics out past its ceiling.
  if (roster.topicsLeftOut > 0) count('topicRosterLeftOut')
  const spend: Spend = {
    model: '',
    tokensIn: 0,
    tokensOut: 0,
    reasoning: 0,
    costUsd: 0,
    cloud: deps.ai.providers.get()?.id === 'cloud',
    verifySent: false
  }
  const inFlight: { id: string | null } = { id: null }
  const onAbort = (): void => {
    if (inFlight.id !== null) cancelInflight(inFlight.id)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // 3–4. The reader, piece by piece.
    /** The pieces whose reply was cut off at its cap (a line's lost topic is then not its fault). */
    const cutPieces = new Set<number>()
    const isListed = (id: string): boolean => roster.topicOf(id) !== null
    const claimIds = new Map<string, string>()
    const answers: { piece: number; answer: ReaderAnswer }[] = []
    /** Paragraphs sent but not read through: they stay unread for the gate and reconcile. */
    const unread = new Set<number>()
    /** Paragraphs a card came from a retry without seeing (its `seen` leaves them out). */
    const unseenByCard = new Set<number>()
    let requests = 0
    for (const [index, piece] of pieces.entries()) {
      const texts = sentTexts(scene, piece)
      const paras = new Set(piece.paragraphs.map((part) => part.p))
      const anchored: string[] = []
      for (const claim of stored) {
        if (!paras.has(claim.para) || claim.recordId === null || claim.state === 'waiting') continue
        const short = `c${claimIds.size + 1}`
        const line = anchoredLine(short, claim, roster)
        if (line === null) continue
        claimIds.set(short, claim.id)
        anchored.push(line)
      }
      // P2b: the re-checking reveals here, so the reader may state them again (on a rebuild,
      // every reveal here: a rebuild checks the scene's secrets and threads afresh too).
      for (const reveal of storedReveals) {
        const short = roster.topicShortOf(reveal.recordId)
        if (!rechecks(reveal) || !paras.has(reveal.para) || short === null) continue
        anchored.push(revealLine(short, reveal))
      }
      const named = [
        ...new Set(
          scene.mentions
            .filter((mention) => !mention.ambiguous && paras.has(mention.para))
            .map((mention) => mention.recordId)
        )
      ]
      const withCard = due && (full || index === 0)
      const windowText = piece.paragraphs.map((part) => texts[part.p] ?? '').join('\n')
      const base = {
        roster: roster.lines,
        topics: roster.topicLines,
        topicLines: topics.lines(windowText, hereBefore),
        position: positionLine(order.refs.get(input.nodeId) ?? null, scene.title, {
          page: index + 1,
          pages: pieces.length,
          full
        }),
        typed: typedLine(scene.details, roster),
        card: cardLine(card, roster),
        near: nearLines(named, draft, roster),
        anchored,
        cardDue: withCard,
        maxTokens: readerV3OutputCap({ proseTokens: piece.tokens, cardDue: withCard })
      }
      const ask = async (
        parts: ReadPiece['paragraphs']
      ): Promise<{ answer: ReaderAnswer | null; cut: boolean }> => {
        const prompt = buildReaderV3Prompt({
          ...base,
          paragraphs: parts.map((part) => ({ p: part.p, text: texts[part.p] ?? '' }))
        })
        // P2b-D10: a topics roster past its 400 tokens is counted (it took the near lines' room).
        if (prompt.trimmed.rosterOver > 0) count('topicRosterOver')
        requests += 1
        const result = await send(deps, input, spend, inFlight, {
          feature: 'reader',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          childId: `${input.requestId}:r${requests}`,
          promptVersion: READER_V3_PROMPT_VERSION
        })
        return { answer: parseReaderAnswer(result.text), cut: result.finishReason === 'length' }
      }
      const first = await ask(piece.paragraphs)
      let answer = first.answer
      /** Retry replies merged into this piece's answer (each renames its own ids apart). */
      let merges = 0
      if (first.cut) {
        yields.cut += 1
        cutPieces.add(index)
        // The paragraphs from the last one quoted are read again, once (all of them when the
        // reply did not keep to paragraph order, so where it stopped says nothing; from the last
        // new name, secret or thread it gave when it was cut inside that list). The last one
        // quoted is read again too, its facts from the cut reply dropped, since its list may
        // stop midway (live run 2026-10-14), unless that would ask the same piece again.
        const last = retryAfter(first.answer, isListed)
        const fromLast = piece.paragraphs.filter((part) => part.p >= last)
        const again = last >= 0 && fromLast.length < piece.paragraphs.length
        const rest = again ? fromLast : piece.paragraphs.filter((part) => part.p > last)
        const retried = (p: number): boolean => (again ? p >= last : p > last)
        if (answer !== null && rest.length > 0) {
          if (again) answer = withoutFrom(answer, last)
          // A knows line or step pointing at a new secret or thread the cut reply never gave is
          // left to the retry when the retry reads its paragraph again.
          answer = withoutLines(answer, danglingTopicIds(answer, isListed), retried)
        }
        // The rest is read in two halves, so each has the whole cap (live run 2026-10-14: a page
        // cut once is mostly cut again when asked whole).
        const half = Math.ceil(rest.length / 2)
        const halves = rest.length >= 2 ? [rest.slice(0, half), rest.slice(half)] : [rest]
        for (const parts of halves) {
          if (parts.length === 0) continue
          const retry = await ask(parts)
          if (retry.cut) yields.cut += 1
          if (retry.answer === null) {
            // A retry that does not parse reads nothing: its paragraphs stay unread.
            for (const part of parts) unread.add(part.p)
            continue
          }
          if (retry.cut) {
            const reached = reachedOf(retry.answer)
            for (const part of parts) if (part.p > reached) unread.add(part.p)
          }
          // The card comes last in a reply: one only a retry gave saw only its paragraphs.
          if ((answer?.card ?? null) === null && retry.answer.card !== null) {
            const seen = new Set(parts.map((part) => part.p))
            for (const part of piece.paragraphs) if (!seen.has(part.p)) unseenByCard.add(part.p)
          }
          merges += 1
          answer =
            answer === null
              ? retry.answer
              : mergeAnswers(answer, retry.answer, isListed, "'".repeat(merges))
        }
      }
      if (answer === null) {
        // Prose, a refusal, an empty reply: nothing was read here, so nothing counts as read.
        reject('unparsed')
        for (const part of piece.paragraphs) unread.add(part.p)
        continue
      }
      for (let i = 0; i < answer.dropped; i += 1) reject('shape')
      answers.push({ piece: index, answer })
    }

    // 5. The ladder.
    const twinRoster = rosterOf(db)
    const askAbout = nameAsker(
      twinRoster,
      { names: dismissedNames(db), aliasKeys: dismissedKeys(db, 'alias') },
      topicLabels(db)
    )
    const isCharacter = (id: string): boolean => scene.kindOf(id) === 'character'
    const items: Item[] = []
    const waitingNames = new Set<string>()
    const texts = pieces.map((piece) => sentTexts(scene, piece))
    const positions = pieces.map((piece) => sentPositions(scene, piece))
    const notRightKeys = dismissedKeys(db, 'notRight')

    /** Tells the observer how a proposed fact ended. */
    const tell = (
      claim: ReaderClaim,
      about: { recordId: string | null; name: string | null },
      outcome: ReadingItemEvent['outcome'],
      stored: ReadingItemEvent['stored'] = null
    ): void =>
      input.observe?.({
        outcome,
        slot: claim.s,
        recordId: about.recordId,
        name: about.name,
        p: claim.p,
        quote: claim.q,
        stored
      })
    /** Refuses a proposed fact: counted by reason, and told. */
    const refuse = (
      reason: LadderReject,
      claim: ReaderClaim,
      about: { recordId: string | null; name: string | null }
    ): void => {
      reject(reason)
      tell(claim, about, reason)
    }

    // P2b: the secrets and threads the reader proposed, before any fact that uses them.
    const newTopics = new Map<string, NewTopic>()
    const restated: Restated[] = []
    for (const { piece, answer } of answers) {
      const caps: Record<TopicKind, number> = { secret: 0, thread: 0 }
      const sent = new Set((pieces[piece]?.paragraphs ?? []).map((part) => part.p))
      for (const topic of answer.topics) {
        // A labelled one is new whatever its id (one reusing a listed id is re-keyed to this
        // piece, so its facts never land on the listed topic, review of P2b slice 2).
        const listed = topic.label === null ? roster.topicOf(topic.id) : null
        if (listed !== null) {
          // A listed one's reveal stated again: kept only for a re-checking reveal in the window
          // (every reveal there on a rebuild), the one in its paragraph first.
          const open = storedReveals.filter(
            (reveal) =>
              reveal.recordId === listed &&
              rechecks(reveal) &&
              sent.has(reveal.para) &&
              !restated.some((each) => each.quoteId === reveal.id)
          )
          const stale = open.find((reveal) => reveal.para === topic.p) ?? open[0]
          if (topics.kindOf(listed) !== topic.kind || stale === undefined) continue
          yields.items += 1
          const location = locate(scene, texts[piece] ?? [], topic.p, topic.q)
          if (typeof location === 'string') {
            reject(location)
            continue
          }
          yields.quotesFound += 1
          restated.push({
            recordId: listed,
            kind: topic.kind,
            piece,
            p: topic.p,
            q: topic.q,
            location,
            stating: statingOf(scene, topic.p, location, names),
            quoteId: stale.id,
            check: null
          })
          continue
        }
        yields.items += 1
        const key = `${piece}:${topic.id.trim()}`
        const label = topicLabel(topic.label ?? '')
        if (label === '' || newTopics.has(key)) {
          reject('shape')
          continue
        }
        const entry: NewTopic = {
          key,
          piece,
          id: topic.id,
          kind: topic.kind,
          label,
          p: topic.p,
          q: topic.q,
          location: null,
          stating: [],
          into: null,
          dropped: null,
          reveal: null,
          same: [],
          mergeInto: null
        }
        newTopics.set(key, entry)
        // P2b-D3: its revealing sentence must stand in the window, in its paragraph, once.
        const location = locate(scene, texts[piece] ?? [], topic.p, topic.q)
        if (typeof location === 'string') {
          entry.dropped = 'topic'
          reject('topic')
          continue
        }
        yields.quotesFound += 1
        entry.location = location
        entry.stating = statingOf(scene, topic.p, location, names)
        // P2b-D13: a reveal the author said is no secret (or thread) drops silently.
        if (
          notRightKeys.has(
            dismissedKey({ kind: 'notRight', topic: { kind: topic.kind, stating: entry.stating } })
          )
        ) {
          entry.dropped = 'dismissed'
          continue
        }
        // Two new ones of one reading with the same label are one.
        const twin = [...newTopics.values()].find(
          (other) =>
            other !== entry &&
            other.into === null &&
            other.dropped === null &&
            other.kind === entry.kind &&
            normName(other.label) === normName(label)
        )
        if (twin !== undefined) {
          entry.into = twin.key
          continue
        }
        // P2b-D11: at most 3 new secrets and 2 new threads a page.
        if (caps[topic.kind] >= TOPIC_CAPS[topic.kind]) {
          entry.dropped = 'topicCap'
          reject('topicCap')
          continue
        }
        caps[topic.kind] += 1
      }
    }
    /** A new topic, followed through a fold to the one it became. */
    const newTopic = (key: string): NewTopic | null => {
      let found = newTopics.get(key) ?? null
      for (let hops = 0; found?.into != null && hops < newTopics.size; hops += 1) {
        found = newTopics.get(found.into) ?? null
      }
      return found
    }
    /**
     * A knows line's secret or a step's thread: new in this piece (a new one given a listed id is
     * this piece's), else listed with that kind.
     */
    const topicRef = (piece: number, id: string | null, kind: TopicKind): TopicRef | null => {
      if (id === null) return null
      const fresh = newTopic(`${piece}:${id.trim()}`)
      if (fresh !== null) return fresh.kind === kind ? { kind: 'new', key: fresh.key } : null
      const listed = roster.topicOf(id)
      if (listed !== null) {
        return topics.kindOf(listed) === kind ? { kind: 'listed', recordId: listed } : null
      }
      return null
    }

    const ladder = (
      piece: number,
      claim: ReaderClaim,
      about:
        | { recordId: string }
        | { name: { norm: string; text: string } }
        /** A name two or more records share: its sentence must name one, or wait on them all. */
        | { owners: string[]; text: string }
        /** P2b: a thread step, whose subject is its thread. */
        | { thread: TopicRef },
      line:
        | { kind: 'fact' }
        | { kind: 'knows' | 'step'; topic: TopicRef; how: string; fromId: string | null } = {
        kind: 'fact'
      }
    ): void => {
      yields.items += 1
      const who = {
        recordId:
          'recordId' in about
            ? about.recordId
            : 'thread' in about && about.thread.kind === 'listed'
              ? about.thread.recordId
              : null,
        name: 'name' in about ? about.name.text : 'owners' in about ? about.text : null
      }
      const parsed =
        line.kind === 'fact' ? readSlot(claim.s) : line.kind === 'knows' ? 'knows' : 'thread'
      // A fact never takes the knows or thread slot: those come as knows lines and steps.
      if (
        parsed === null ||
        (line.kind === 'fact' && (slotGroup(parsed) === 'knows' || slotGroup(parsed) === 'thread'))
      ) {
        return refuse('slot', claim, who)
      }
      const slot: Slot = parsed
      const location = locate(scene, texts[piece] ?? [], claim.p, claim.q)
      if (typeof location === 'string') return refuse(location, claim, who)
      yields.quotesFound += 1
      const quote = location.sentences.map((i) => scene.ladderSentence(scene.position(claim.p, i)))
      const firstPosition = quote[0]?.position ?? -1
      const sent = positions[piece] ?? new Set<number>()
      const before: LadderSentence[] = []
      for (let position = firstPosition - 1; position >= 0; position -= 1) {
        if (sent.has(position)) before.push(scene.ladderSentence(position))
      }
      const speakerId =
        (claim.voice === 'dialogue' || claim.voice === 'thought') && claim.sp !== null
          ? roster.recordOf(claim.sp)
          : null
      const objectId =
        line.kind === 'knows'
          ? line.topic.kind === 'listed'
            ? line.topic.recordId
            : null
          : line.kind === 'fact' && OBJECT_SLOTS.includes(slot) && claim.o !== null
            ? roster.recordOf(claim.o)
            : null
      const item: Item = {
        piece,
        claim,
        kind: line.kind,
        slot,
        recordId: who.recordId,
        name: 'name' in about ? about.name : null,
        objectId,
        speakerId,
        topic: line.kind === 'fact' ? null : line.topic,
        how: line.kind === 'fact' ? null : line.how,
        fromId: line.kind === 'knows' ? line.fromId : null,
        location,
        quote,
        subject: { kind: 'none' },
        proof: null,
        spotCheck: null,
        value:
          line.kind === 'knows'
            ? line.how
            : line.kind === 'step'
              ? capWords(claim.v.trim() === '' ? line.how : claim.v, STEP_VALUE_MAX_WORDS)
              : claim.v.trim(),
        check: null
      }
      let literalNames: (sentence: LadderSentence) => readonly LiteralName[] = (s) => s.names
      // A told, overheard or read line quoting its source's words: their first person is the
      // source's, and the learner is found in reach (P2b slice 3, the knows replays).
      const knowsHow = line.kind === 'knows' ? parseHow(line.how) : null
      const sourceId = knowsHow !== null && keepsFrom(knowsHow) ? item.fromId : null
      const resolve = (recordId: string): SubjectResult =>
        resolveSubject({
          recordId,
          voice: claim.voice,
          speakerId,
          quote,
          before,
          typedPov: scene.details.povRecordId,
          isCharacter,
          sourceId
        })
      if ('thread' in about) {
        item.subject = { kind: 'topic' }
      } else if ('recordId' in about) {
        item.subject = resolve(about.recordId)
        if (line.kind === 'knows') {
          // P2b-D8: a group knows only where its sentence names it, its head noun enough ("the
          // whole regiment knew", amended in review); a knows line never waits.
          if (scene.kindOf(about.recordId) === 'group' && item.subject.kind !== 'named') {
            const head = groupHeadIn(
              (recordsById.get(about.recordId)?.aliases ?? []).map((alias) => alias.text),
              quote.map((sentence) => sentence.text)
            )
            if (head === null) return refuse('group', claim, who)
            item.subject = { kind: 'named', text: head }
          }
          if (item.subject.kind === 'shared') return refuse('subject', claim, who)
        }
      } else if ('owners' in about) {
        // The scan settles a shared name in the sentence, or the fact waits on its owners there.
        const tried = about.owners.map((id) => ({ id, subject: resolve(id) }))
        const hit =
          tried.find((entry) => entry.subject.kind === 'named') ??
          tried.find((entry) => entry.subject.kind === 'shared')
        if (hit === undefined) return refuse('subject', claim, who)
        item.recordId = hit.id
        item.subject = hit.subject
      } else {
        // A new name pins its facts only by standing in their sentence (nothing is guessed).
        const found = quote
          .map((sentence) => ({ sentence, at: nameInSentence(sentence.text, about.name.text) }))
          .find((entry) => entry.at !== null)
        if (found?.at == null) return refuse('subject', claim, who)
        const span = found.at
        item.subject = { kind: 'newName', text: about.name.text }
        literalNames = (sentence) =>
          sentence.position === found.sentence.position
            ? [
                ...sentence.names,
                {
                  recordId: `name:${about.name.norm}`,
                  kind: 'character',
                  start: span.start,
                  end: span.end,
                  ambiguous: false
                }
              ]
            : sentence.names
      }
      if (item.subject.kind === 'none') return refuse('subject', claim, who)
      if (line.kind === 'fact') {
        // The code gates of the live run of 2026-10-14, before literal proof and the checker: a
        // place holds no person's slot, the value is the quote's own words, a fact read as now
        // is not a wish, and the quote itself names or points at its subject as one person
        // (never "the sisters", never only "you", never a sentence whose name the quote left out).
        if (item.recordId !== null && !slotFitsKind(slot, scene.kindOf(item.recordId))) {
          return refuse('kind', claim, who)
        }
        if (!valueStated(slot, item.value, claim.q)) return refuse('value', claim, who)
        if (wishWord(slot, claim.mode, claim.q) !== null) return refuse('wish', claim, who)
        const subject = item.subject
        const calledBy =
          subject.kind === 'newName' || subject.kind === 'shared'
            ? [subject.text]
            : quote.flatMap((sentence) =>
                sentence.names
                  .filter((name) => name.recordId === item.recordId)
                  .map((name) => sentence.text.slice(name.start, name.end))
              )
        const pointed = quotePointsAtSubject({
          slot,
          quote: claim.q,
          names: calledBy,
          // The subject's own words: "I" is them, whether the sentence names them or not.
          firstPerson:
            subject.kind === 'firstPerson' || (speakerId !== null && speakerId === item.recordId)
        })
        if (!pointed) return refuse('subject', claim, who)
      }
      const single = quote.length === 1 ? quote[0] : undefined
      const span = scene.spans[claim.p]?.[location.sentences[0] ?? -1]
      // Knows lines and steps never take literal proof (P2b): the checker confirms them.
      if (
        line.kind === 'fact' &&
        single !== undefined &&
        span !== undefined &&
        (item.subject.kind === 'named' || item.subject.kind === 'newName')
      ) {
        const proved = literalProof(
          {
            recordId: item.recordId ?? `name:${item.name?.norm ?? ''}`,
            slot,
            value: claim.v,
            objectId,
            voice: claim.voice,
            mode: claim.mode,
            quote: claim.q
          },
          { paragraphs: scene.texts, p: claim.p, span },
          literalNames(single)
        )
        if (proved.ok) {
          item.proof = 'literal'
          item.value = proved.value
          yields.literal += 1
        }
      }
      items.push(item)
    }

    /**
     * P2b: a knows line or a thread step, its topic and how read before the ladder. A fact that
     * came with a dropped new topic goes with it (silently for one the author dismissed).
     */
    const topicLine = (piece: number, claim: ReaderClaim): void => {
      const knows = claim.s === 'knows'
      const id = knows ? claim.o : claim.r
      const ref = topicRef(piece, id, knows ? 'secret' : 'thread')
      const nobody = { recordId: null, name: null }
      if (ref === null) {
        if (cutPieces.has(piece) && id !== null && !isListed(id)) {
          // Its new secret or thread was in the part of the reply cut off: not the reader's
          // error; its paragraph is read again (review of P2b slice 2).
          refuse('unanswered', claim, nobody)
          unread.add(claim.p)
          return
        }
        yields.items += 1
        return refuse('record', claim, nobody)
      }
      if (ref.kind === 'new') {
        const dropped = newTopics.get(ref.key)?.dropped ?? null
        if (dropped === 'dismissed') return
        // A fact riding a dropped topic goes with it; its quote was never looked for, so it is
        // not an item for the health gate (review of P2b slice 2).
        if (dropped !== null) {
          return refuse(dropped === 'topicCap' ? 'topicCap' : 'topic', claim, nobody)
        }
      }
      if (!knows) {
        const step = parseStep(claim.how)
        if (step === null) {
          yields.items += 1
          return refuse('slot', claim, nobody)
        }
        ladder(piece, claim, { thread: ref }, { kind: 'step', topic: ref, how: step, fromId: null })
        return
      }
      const how = parseHow(claim.how)
      const learner = claim.r === null ? null : roster.recordOf(claim.r)
      const kind = learner === null ? undefined : scene.kindOf(learner)
      if (how === null || learner === null || kind === undefined || !KNOWER_KINDS.includes(kind)) {
        yields.items += 1
        return refuse(how === null ? 'slot' : 'record', claim, { recordId: learner, name: null })
      }
      const fromId = claim.fr === null ? null : roster.recordOf(claim.fr)
      ladder(piece, claim, { recordId: learner }, { kind: 'knows', topic: ref, how, fromId })
    }

    for (const { piece, answer } of answers) {
      for (const claim of answer.claims) {
        if (claim.s === 'knows' || claim.s === 'thread') {
          topicLine(piece, claim)
          continue
        }
        const recordId = claim.r === null ? null : roster.recordOf(claim.r)
        if (recordId === null) {
          yields.items += 1
          refuse('record', claim, { recordId: null, name: null })
          continue
        }
        ladder(piece, claim, { recordId })
      }
      for (const named of answer.names) {
        // P2b-D8: a learner is a record Here; a new name's facts never hold knows lines or steps.
        const plain = named.c.filter((claim) => claim.s !== 'knows' && claim.s !== 'thread')
        for (const claim of named.c.filter((each) => !plain.includes(each))) {
          yields.items += 1
          refuse('name', claim, { recordId: null, name: named.n })
        }
        const norm = normName(named.n)
        const owners = twinRoster.filter((record) =>
          record.names.some((text) => normName(text) === norm)
        )
        const [owner, ...others] = owners
        if (owner !== undefined) {
          // A name the roster has after all: its facts are that record's, or, when records share
          // it, the one the sentence settles (else they wait on all of them, P2a-D22).
          for (const claim of plain) {
            if (others.length === 0) ladder(piece, claim, { recordId: owner.id })
            else ladder(piece, claim, { owners: owners.map((each) => each.id), text: named.n })
          }
          continue
        }
        // Kept waiting only when a question will ask about it (identity rule 6: capitalised
        // mid-sentence, here in its paragraph), so every wait has an answer that settles it.
        const midSentence = nameSpans(scene.texts[named.p] ?? '').some(
          (span) => span.key === norm && !span.sentenceStart
        )
        const refused = !midSentence || askAbout(named.n) === null
        if (refused) {
          for (const claim of plain) {
            yields.items += 1
            refuse('name', claim, { recordId: null, name: named.n })
          }
          continue
        }
        for (const claim of plain) ladder(piece, claim, { name: { norm, text: named.n } })
      }
    }

    // The card: each field from the first page whose reply gives it and whose quote stands in
    // the paragraphs that page sent (a page's quote is looked for in its own text); the first
    // page's line and gist; who is on the page from every page. POV, year, flashback and
    // presence go to the checker in the batch of the page they came from.
    const cards = due
      ? answers.flatMap(({ piece, answer }) =>
          answer.card === null ? [] : [{ piece, card: answer.card }]
        )
      : []
    const merged: ReaderCard | null = cards[0]?.card ?? null
    const placeIn = (piece: number, field: ReaderCardField): PlacedField | null => {
      const location = locate(scene, texts[piece] ?? [], field.p, field.q)
      return typeof location === 'string' ? null : { field, location, piece }
    }
    const place = (
      get: (card: ReaderCard) => ReaderCardField | null,
      valid: (field: ReaderCardField) => boolean = () => true
    ): PlacedField | null => {
      for (const { piece, card } of cards) {
        const field = get(card)
        if (field === null || !valid(field)) continue
        const placed = placeIn(piece, field)
        if (placed !== null) return placed
      }
      return null
    }
    const isPov = (field: ReaderCardField): boolean => {
      const recordId = roster.recordOf(field.value)
      return recordId !== null && isCharacter(recordId)
    }
    const fields = {
      where: place((card) => card.where),
      when: place((card) => card.when),
      year: place((card) => card.year),
      elapsed: place((card) => card.elapsed),
      pov: place((card) => card.pov, isPov),
      flashback: place((card) => card.flash)
    }
    const povRecord = fields.pov === null ? null : roster.recordOf(fields.pov.field.value)
    const presentEntries: { recordId: string; placed: PlacedField }[] = []
    for (const { piece, card } of cards) {
      for (const entry of card.present) {
        const recordId = roster.recordOf(entry.value)
        if (recordId === null || !isCharacter(recordId)) continue
        if (presentEntries.some((other) => other.recordId === recordId)) continue
        const placed = placeIn(piece, entry)
        if (placed !== null) presentEntries.push({ recordId, placed })
      }
    }
    const firstOf = (get: (card: ReaderCard) => string | null): string | null =>
      cards.map(({ card }) => get(card)).find((value) => value !== null) ?? null
    const mood = firstOf((card) => card.mood)
    const theme = firstOf((card) => card.theme)

    // The checker: batches per page.
    const checks: Check[] = []
    const around = (location: QuoteLocation, p: number, naming?: number): string => {
      const quoted = location.sentences.map((i) => scene.position(p, i))
      return contextText(scene, Math.min(...quoted), Math.max(...quoted), naming)
    }
    /** How a checker item names a knows line's secret or a step's thread. */
    const topicText = (ref: TopicRef): string => {
      if (ref.kind === 'listed') return topics.itemLine(ref.recordId)
      const fresh = newTopic(ref.key)
      return fresh === null ? '?' : `${fresh.id} ${fresh.label}: “${fresh.q}”`
    }
    /**
     * A knows line's source candidates (P2b §2.3): the reader's source, the quote's speaker, and
     * every character or group named in the quote's sentences ±1; never the learner.
     */
    const fromCandidates = (item: Item): string[] => {
      const out: string[] = []
      const add = (id: string | null): void => {
        if (id === null || id === item.recordId || out.includes(id)) return
        const kind = scene.kindOf(id)
        if (kind !== undefined && KNOWER_KINDS.includes(kind)) out.push(id)
      }
      add(item.fromId)
      add(item.speakerId)
      const quoted = item.quote.map((sentence) => sentence.position)
      const first = Math.min(...quoted)
      const last = Math.max(...quoted)
      for (let position = Math.max(0, first - 1); position <= last + 1; position += 1) {
        for (const name of scene.ladderSentence(position).names) {
          if (!name.ambiguous) add(name.recordId)
        }
      }
      return out
    }
    const spotEvery = input.spotEvery ?? null
    for (const [index, item] of items.entries()) {
      if (item.proof === 'literal') {
        // After a rebuild, one new literal claim in 20 rides its page's batch (P2a-D8).
        const key = `${input.nodeId}|${item.claim.p}|${item.claim.q}|${item.slot}`
        if (spotEvery === null || item.recordId === null || !spotPicked(key, spotEvery)) continue
        item.spotCheck = checks.length
        checks.push({
          kind: 'claim',
          who: [roster.whoLine(item.recordId)],
          fact: factText(item, roster),
          text: around(item.location, item.claim.p),
          piece: item.piece,
          target: { kind: 'spot', index, expect: roster.shortOf(item.recordId) },
          ids: new Map()
        })
        continue
      }
      const subject = item.subject
      if (subject.kind === 'topic') {
        // A thread step: its thread is fixed, the checker confirms the step (P2b).
        item.check = checks.length
        checks.push({
          kind: 'step',
          who: [],
          topic: item.topic === null ? '?' : topicText(item.topic),
          fact: factText(item, roster),
          text: around(item.location, item.claim.p),
          piece: item.piece,
          target: { kind: 'item', index, expect: null, candidates: [], from: [] },
          ids: new Map()
        })
        continue
      }
      let candidates: string[] = []
      let naming: number | undefined
      if (subject.kind === 'named' || subject.kind === 'firstPerson') {
        candidates = item.recordId === null ? [] : [item.recordId]
      } else if (subject.kind === 'shared' || subject.kind === 'antecedent') {
        candidates = subject.candidates
        if (subject.kind === 'antecedent') naming = subject.naming
      }
      const ids = new Map<string, string>()
      const unnamed = subject.kind === 'antecedent' ? subject.unnamed : null
      const who =
        subject.kind === 'newName'
          ? [`n1 ${subject.text} (a name not on the roster)`]
          : candidates.map((id) => {
              ids.set(roster.shortOf(id), id)
              return id === unnamed
                ? `${roster.whoLine(id)}${VERIFY_UNNAMED_MARK}`
                : roster.whoLine(id)
            })
      if (subject.kind === 'newName') ids.set('n1', `name:${item.name?.norm ?? ''}`)
      const from = item.kind === 'knows' ? fromCandidates(item) : []
      for (const id of from) ids.set(roster.shortOf(id), id)
      item.check = checks.length
      checks.push({
        kind: item.kind === 'knows' ? 'knows' : 'claim',
        who,
        ...(item.kind === 'knows'
          ? {
              from: from.map((id) => roster.whoLine(id)),
              topic: item.topic === null ? '?' : topicText(item.topic)
            }
          : {}),
        fact: factText(item, roster),
        text: around(item.location, item.claim.p, naming),
        piece: item.piece,
        target: {
          kind: 'item',
          index,
          expect:
            subject.kind === 'newName'
              ? 'n1'
              : item.recordId === null
                ? null
                : roster.shortOf(item.recordId),
          candidates,
          from
        },
        ids
      })
    }
    const cardCheck = (kind: 'pov' | 'year' | 'flashback', placed: PlacedField | null): void => {
      if (placed === null) return
      const fact =
        kind === 'pov'
          ? `the scene is told from ${roster.shortOf(povRecord ?? '')}'s point of view`
          : kind === 'year'
            ? `the story year here is ${placed.field.value}`
            : placed.field.value === 'yes'
              ? 'this passage is a flashback (it happened before the scene’s present)'
              : 'this passage is not a flashback'
      checks.push({
        kind,
        who: kind === 'pov' && povRecord !== null ? [roster.whoLine(povRecord)] : [],
        fact,
        text: around(placed.location, placed.field.p),
        piece: placed.piece,
        target: { kind: 'card', field: kind },
        ids: new Map()
      })
    }
    cardCheck('pov', fields.pov)
    cardCheck('year', fields.year)
    cardCheck('flashback', fields.flashback)
    const onPage = (recordId: string): string => onPageFact(roster, recordId)
    for (const [index, entry] of presentEntries.entries()) {
      checks.push({
        kind: 'present',
        who: [roster.whoLine(entry.recordId)],
        fact: onPage(entry.recordId),
        text: around(entry.placed.location, entry.placed.field.p),
        piece: entry.placed.piece,
        target: { kind: 'present', index },
        ids: new Map()
      })
    }
    // P2b-D8: a named character learner not Here before the reading gets one on-page check per
    // page, on the sentences of its first knows line there, even when this reading's card names
    // them (the card's own check may fail where the knows sentence shows them, review of slice 2).
    const hereChecks = new Set<string>()
    for (const item of items) {
      const learner = item.recordId
      if (item.kind !== 'knows' || learner === null || !isCharacter(learner)) continue
      if (item.subject.kind !== 'named' && item.subject.kind !== 'firstPerson') continue
      if (hereBefore.has(learner)) continue
      const key = `${item.piece}:${learner}`
      if (hereChecks.has(key)) continue
      hereChecks.add(key)
      checks.push({
        kind: 'present',
        who: [roster.whoLine(learner)],
        fact: onPage(learner),
        text: around(item.location, item.claim.p),
        piece: item.piece,
        target: { kind: 'here', recordId: learner },
        ids: new Map()
      })
    }
    // P2b-D3, D4: each new topic's reveal, and the open topics it may repeat (at most 3).
    const kept = [...newTopics.values()].filter(
      (topic): topic is NewTopic & { location: QuoteLocation } =>
        topic.into === null && topic.dropped === null && topic.location !== null
    )
    const open = new Map<TopicKind, TopicFacet[]>()
    const openOf = (kind: TopicKind): TopicFacet[] => {
      const known = open.get(kind)
      if (known !== undefined) return known
      const found = topics.open(kind)
      open.set(kind, found)
      return found
    }
    const ref = order.refs.get(input.nodeId) ?? '?'
    /** The facets of this reading's new topics, compared like open ones (a page with the ones before it). */
    const freshFacets = new Map<string, TopicFacet>()
    for (const topic of kept) {
      topic.reveal = checks.length
      checks.push({
        kind: 'reveals',
        who: [],
        topic: `${topic.id} ${topic.label} · new ${topic.kind}`,
        fact: '',
        text: around(topic.location, topic.p),
        piece: topic.piece,
        target: { kind: 'reveal', key: topic.key },
        ids: new Map()
      })
      const holders = items.flatMap((item) =>
        item.kind === 'knows' &&
        item.recordId !== null &&
        item.topic?.kind === 'new' &&
        newTopic(item.topic.key) === topic
          ? [item.recordId]
          : []
      )
      const fresh: TopicFacet = {
        id: topic.key,
        kind: topic.kind,
        terms: topics.termsOf(topic.label, topic.q),
        holders
      }
      // The open topics, and the new ones earlier pages of this reading proposed: a secret a long
      // scene reveals on page 1 and a later page proposes again under its own label is judged in
      // the same batch (review of P2b slice 2).
      const earlier = [...freshFacets.values()].filter(
        (facet) => (newTopics.get(facet.id)?.piece ?? topic.piece) < topic.piece
      )
      for (const candidate of sameAsCandidates(fresh, [...openOf(topic.kind), ...earlier], {
        max: 3
      })) {
        const other = newTopics.get(candidate.id)
        const target: TopicRef =
          other === undefined
            ? { kind: 'listed', recordId: candidate.id }
            : { kind: 'new', key: other.key }
        let side: string
        if (other !== undefined) {
          side = `new ${other.label}: “${other.q}” (${ref})`
        } else {
          const reveal = topics.revealOf(candidate.id)
          const listed = `${roster.topicShortOf(candidate.id) ?? '?'} ${topics.labelOf(candidate.id)}`
          side = reveal === null ? listed : `${listed}: “${reveal.quote}” (${reveal.ref})`
        }
        topic.same.push({ target, check: checks.length })
        checks.push({
          kind: 'same',
          who: [],
          topic: `${topic.id} ${topic.label}: “${topic.q}” (${ref}) | ${side}`,
          fact: '',
          text: '',
          piece: topic.piece,
          target: { kind: 'same', key: topic.key, with: target },
          ids: new Map()
        })
      }
      freshFacets.set(topic.key, fresh)
    }
    for (const [index, entry] of restated.entries()) {
      entry.check = checks.length
      checks.push({
        kind: 'reveals',
        who: [],
        topic: `${roster.topicShortOf(entry.recordId) ?? '?'} ${topics.labelOf(entry.recordId)} · ${entry.kind}`,
        fact: '',
        text: around(entry.location, entry.p),
        piece: entry.piece,
        target: { kind: 'restated', index },
        ids: new Map()
      })
    }

    const verdicts = new Map<number, VerifyVerdict>()
    let batchNo = 0
    /** Sends one batch and keeps its verdicts; true when the reply was cut off at its cap. */
    const runBatch = async (batch: readonly (Check & { at: number })[]): Promise<boolean> => {
      batchNo += 1
      const prompt = buildVerifyV3Prompt({ items: batch })
      const result = await send(deps, input, spend, inFlight, {
        feature: 'verify',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        childId: `${input.requestId}:v${batchNo}`,
        promptVersion: VERIFY_V3_PROMPT_VERSION
      })
      const answered = parseVerifyAnswer(result.text)
      for (const [i, entry] of batch.entries()) {
        const verdict = answered.get(i + 1)
        if (verdict !== undefined) verdicts.set(entry.at, verdict)
      }
      return result.finishReason === 'length'
    }
    for (let piece = 0; piece < pieces.length; piece += 1) {
      const own = checks
        .map((check, index) => ({ ...check, at: index }))
        .filter((entry) => entry.piece === piece)
      for (const batch of verifyV2Batches(own)) {
        if (!(await runBatch(batch))) continue
        yields.cut += 1
        // The items a cut-off reply did not reach are asked once more.
        const missing = batch.filter((entry) => !verdicts.has(entry.at))
        for (const again of verifyV2Batches(missing)) {
          if (await runBatch(again)) yields.cut += 1
        }
      }
    }

    // The card's verdicts: POV, year and flashback feed computation only when verified.
    const checked = (
      target: Check['target']['kind'],
      match: (check: Check) => boolean
    ): boolean => {
      const index = checks.findIndex((check) => check.target.kind === target && match(check))
      return index !== -1 && verdicts.get(index)?.ok === true
    }
    const cardField = (
      placed: PlacedField | null,
      value: string,
      verified: boolean
    ): CardField | null =>
      placed === null ? null : { value, quote: placed.field.q, p: placed.field.p, verified }
    const fieldVerified = (field: 'pov' | 'year' | 'flashback'): boolean =>
      checked('card', (check) => check.target.kind === 'card' && check.target.field === field)
    const cardFields: CardFields =
      merged === null
        ? emptyCardFields()
        : {
            where: cardField(fields.where, fields.where?.field.value ?? '', false),
            when: cardField(fields.when, fields.when?.field.value ?? '', false),
            pov: cardField(fields.pov, povRecord ?? '', fieldVerified('pov')),
            year: cardField(fields.year, fields.year?.field.value ?? '', fieldVerified('year')),
            flashback: cardField(
              fields.flashback,
              fields.flashback?.field.value ?? '',
              fieldVerified('flashback')
            ),
            elapsed: cardField(fields.elapsed, fields.elapsed?.field.value ?? '', false)
          }
    const cardPresent: CardPresent[] = presentEntries.map((entry, index) => ({
      recordId: entry.recordId,
      quote: entry.placed.field.q,
      p: entry.placed.field.p,
      verified: checked(
        'present',
        (check) => check.target.kind === 'present' && check.target.index === index
      )
    }))
    // First person counts for the typed POV only when the text's POV, verified, agrees.
    const textPov =
      cardFields.pov?.verified === true
        ? cardFields.pov.value
        : card?.fields.pov?.verified === true
          ? card.fields.pov.value
          : null

    // P2b-D8: who is Here for a knows line: the typed details and the held card, this reading's
    // verified POV and on-page entries, and the learners an on-page check showed on the page.
    const hereNow = new Set(hereBefore)
    if (cardFields.pov?.verified === true) hereNow.add(cardFields.pov.value)
    for (const entry of cardPresent) if (entry.verified) hereNow.add(entry.recordId)
    const shownHere = new Set<string>()
    /** Learners whose on-page check got no verdict: their lines are read again, not refused. */
    const hereUnanswered = new Set<string>()
    for (const [index, check] of checks.entries()) {
      if (check.target.kind !== 'here') continue
      const verdict = verdicts.get(index)
      if (verdict?.ok === true) shownHere.add(check.target.recordId)
      else if (verdict === undefined) hereUnanswered.add(check.target.recordId)
    }

    /**
     * P2b-D7 (review of slice 2): a secret's reveal counts only as narration, thought or dialogue
     * in the story's now or a memory; one the text gives as a rumour, a hypothetical or a dream
     * makes no secret and sets no "readers have known since". A thread is set up however it is
     * said (a vow or a plan is a hypothetical). A verdict that leaves voice or mode out is read as
     * the reader's own (narration, now): the checker said it reveals it.
     */
    const revealCounts = (kind: TopicKind, verdict: VerifyVerdict): boolean =>
      kind === 'thread' ||
      (verdict.voice !== 'rumour' && verdict.mode !== 'hypothetical' && verdict.mode !== 'dream')
    /** Whether a same-as target still stands: an open topic not deleted meanwhile, or a new one kept. */
    const stands = (target: TopicRef): boolean =>
      target.kind === 'listed'
        ? getRecord(db, target.recordId) !== null
        : newTopics.get(target.key)?.dropped === null
    // P2b-D3, D4: each new topic's reveal, then the first topic judged the same (in page order,
    // so an earlier page's new topic is settled before a later one may merge into it).
    for (const topic of kept) {
      const verdict = topic.reveal === null ? undefined : verdicts.get(topic.reveal)
      // A missing verdict is no judgment: a reveal or a same-as check the checker never answered
      // leaves the topic, its facts and its paragraph to the next reading (a missing "same as"
      // is not "not the same", review of slice 2).
      if (verdict === undefined || topic.same.some((each) => !verdicts.has(each.check))) {
        topic.dropped = 'unanswered'
        reject('unanswered')
        unread.add(topic.p)
        continue
      }
      yields.verifySent += 1
      if (!verdict.ok) {
        topic.dropped = 'topic'
        reject('topic')
        continue
      }
      yields.verified += 1
      if (!revealCounts(topic.kind, verdict)) {
        topic.dropped = 'notCounted'
        count('topicNotCounted')
        continue
      }
      const same = topic.same.find(
        (each) => verdicts.get(each.check)?.ok === true && stands(each.target)
      )
      topic.mergeInto = same?.target ?? null
      count(topic.mergeInto === null ? 'topicsCreated' : 'topicsMerged')
    }
    /** The restated reveals the checker passed, to revive; unanswered ones leave their paragraph unread. */
    const revived: Restated[] = []
    for (const entry of restated) {
      const verdict = entry.check === null ? undefined : verdicts.get(entry.check)
      if (verdict === undefined) {
        reject('unanswered')
        unread.add(entry.p)
        continue
      }
      yields.verifySent += 1
      if (!verdict.ok) {
        reject('topic')
        continue
      }
      yields.verified += 1
      // A secret's sentence that now only rumours it is no reveal: it is not revived, and goes.
      if (!revealCounts(entry.kind, verdict)) {
        count('topicNotCounted')
        continue
      }
      revived.push(entry)
    }

    // The claims' verdicts.
    const fresh: FreshClaim[] = []
    /** P2b: a knows line or step about a topic new in this reading: its key, to point it there. */
    const freshTopic = new Map<FreshClaim, string>()
    /** The fast spot checks' verdicts on literal claims, set on the rows once they are stored. */
    const spotOf = new Map<FreshClaim, SpotVerdict>()
    /** The facts the checker refused, as proposed: a stored claim stating the same is rejected. */
    const rejectedQuotes: {
      recordId: string | null
      slot: Slot
      quote: string
      valueKey: string
      voice: ClaimVoice
      mode: ClaimMode
    }[] = []
    const proved = (
      item: Item,
      at: {
        recordId: string | null
        pending: ClaimPending | null
        subjectText: string | null
        voice: ClaimVoice
        mode: ClaimMode
        proof: 'literal' | 'verified'
        naming?: number
        /** P2b: the checker's how and source of a knows line, its step of a thread step. */
        how?: string | null
        fromId?: string | null
      }
    ): FreshClaim => {
      const anchor = [...anchorFor(scene.sentences, item.location, at.naming)]
      const speakerId = at.voice === 'dialogue' || at.voice === 'thought' ? item.speakerId : null
      const how = at.how ?? null
      const fact: FreshClaim = {
        recordId: at.recordId,
        pending: at.pending,
        subjectText: at.subjectText,
        slot: item.slot,
        // A knows line's value is its how (P2b-D6), as the checker read it.
        value: item.kind === 'knows' && how !== null ? how : item.value,
        valueKey: valueKey(item.kind === 'knows' && how !== null ? how : item.value),
        objectId: item.objectId,
        how,
        fromId: at.fromId ?? null,
        topicQuoteId: null,
        voice: at.voice,
        speakerId,
        mode: at.mode,
        quote: item.claim.q,
        para: item.claim.p,
        anchor,
        stating: item.quote.map((sentence) => gateText(sentence.text, names)),
        proof: at.proof,
        change: item.claim.chg
      }
      if (item.topic?.kind === 'new') freshTopic.set(fact, item.topic.key)
      return fact
    }
    /**
     * A knows line the checker supported whose learner the Here rule refuses in code (P2b-D8): not
     * held against the checker; one whose on-page check got no verdict is read again.
     */
    const notHere = (
      why: 'notHere' | 'unanswered',
      item: Item,
      who: { recordId: string | null; name: string | null }
    ): void => {
      yields.verifySent -= 1
      refuse(why, item.claim, who)
      if (why === 'unanswered') unread.add(item.claim.p)
    }
    for (const item of items) {
      const subject = item.subject
      const who = { recordId: item.recordId, name: item.name?.text ?? null }
      const namePending: ClaimPending | null =
        item.name === null ? null : { kind: 'name', norm: item.name.norm, text: item.name.text }
      const subjectText =
        subject.kind === 'named' || subject.kind === 'newName' ? subject.text : null
      /** Keeps a proved fact: stored live, or waiting on its subject or its new name. */
      const keep = (fact: FreshClaim): void => {
        fresh.push(fact)
        if (fact.pending?.kind === 'name') waitingNames.add(fact.pending.norm)
        if (fact.proof === 'verified') yields.verified += 1
        tell(
          item.claim,
          who,
          fact.pending !== null ? 'waiting' : fact.proof === 'literal' ? 'literal' : 'verified',
          { recordId: fact.recordId, voice: fact.voice, mode: fact.mode }
        )
      }
      if (item.proof === 'literal') {
        const fact = proved(item, {
          recordId: item.recordId,
          pending: namePending,
          subjectText,
          voice: item.claim.voice,
          mode: item.claim.mode,
          proof: 'literal'
        })
        keep(fact)
        const spotCheck = item.spotCheck === null ? undefined : checks[item.spotCheck]
        const spotVerdict = item.spotCheck === null ? undefined : verdicts.get(item.spotCheck)
        if (spotCheck?.target.kind === 'spot' && spotVerdict !== undefined) {
          spotOf.set(
            fact,
            agrees(spotVerdict, {
              expect: spotCheck.target.expect,
              voice: item.claim.voice,
              mode: item.claim.mode
            })
              ? 'agree'
              : 'disagree'
          )
        }
        continue
      }
      const verdict = item.check === null ? undefined : verdicts.get(item.check)
      const check = item.check === null ? undefined : checks[item.check]
      if (verdict === undefined || check === undefined) {
        // No verdict: not the checker's refusal, so not held against it or the stored claims;
        // the paragraph stays unread and is read again.
        refuse('unanswered', item.claim, who)
        unread.add(item.claim.p)
        continue
      }
      // A knows line or step whose new topic the checker did not find revealed goes with it; one
      // whose topic got no verdict is read again (review of P2b slice 2).
      const topic = item.topic?.kind === 'new' ? newTopic(item.topic.key) : null
      if (topic !== null && topic.dropped !== null) {
        refuse(topic.dropped === 'unanswered' ? 'unanswered' : 'topic', item.claim, who)
        if (topic.dropped === 'unanswered') unread.add(item.claim.p)
        continue
      }
      yields.verifySent += 1
      if (!verdict.ok) {
        refuse('unsupported', item.claim, who)
        rejectedQuotes.push({
          recordId: item.recordId,
          slot: item.slot,
          quote: item.claim.q,
          valueKey: valueKey(item.value),
          voice: item.claim.voice,
          mode: item.claim.mode
        })
        continue
      }
      if (verdict.voice === null || verdict.mode === null) {
        refuse('unconfirmed', item.claim, who)
        continue
      }
      const target = check.target.kind === 'item' ? check.target : null
      const answered = verdict.r === null ? null : (check.ids.get(verdict.r) ?? '')
      const base = { voice: verdict.voice, mode: verdict.mode, proof: 'verified' as const }
      if (item.kind === 'step') {
        // The checker's step wins (P2b): one it does not name is no verdict on it.
        const step = parseStep(verdict.how)
        if (step === null) {
          refuse('unconfirmed', item.claim, who)
          continue
        }
        keep(
          proved(item, {
            ...base,
            recordId: item.recordId,
            pending: null,
            subjectText: null,
            how: step
          })
        )
        continue
      }
      // A knows line (P2b): the checker's how and source win; its learner is settled or refused.
      const how = item.kind === 'knows' ? parseHow(verdict.how) : null
      if (item.kind === 'knows' && how === null) {
        refuse('unconfirmed', item.claim, who)
        continue
      }
      const learnerLine = (
        learner: string
      ): { how: string | null; fromId: string | null } | 'notHere' | 'unanswered' => {
        if (how === null) return { how: null, fromId: null }
        // P2b-D8: a character learner is Here or the POV, or shown on the page.
        if (isCharacter(learner) && !hereNow.has(learner) && !shownHere.has(learner)) {
          return hereUnanswered.has(learner) ? 'unanswered' : 'notHere'
        }
        const source = verdict.fr === null ? null : (check.ids.get(verdict.fr) ?? null)
        return {
          how,
          fromId:
            keepsFrom(how) && source !== null && (target?.from ?? []).includes(source)
              ? source
              : null
        }
      }
      if (subject.kind === 'shared') {
        // A shared alias waits for the name scan (P2a-D22), whoever the checker picked.
        keep(
          proved(item, {
            ...base,
            recordId: null,
            pending: { kind: 'subject', candidates: subject.candidates },
            subjectText: subject.text
          })
        )
        continue
      }
      if (subject.kind === 'antecedent') {
        if (answered !== null && !subject.candidates.includes(answered)) {
          refuse('subject', item.claim, who)
          continue
        }
        // Null with one candidate: none fits. With more, more than one does: it waits, and the
        // next full read drops it (P2a-D23). A knows line never waits (P2b).
        if (answered === null && (subject.candidates.length < 2 || item.kind === 'knows')) {
          refuse('unconfirmed', item.claim, who)
          continue
        }
        const known = answered === null ? { how: null, fromId: null } : learnerLine(answered)
        if (typeof known === 'string') {
          notHere(known, item, { ...who, recordId: answered })
          continue
        }
        // The anchor keeps the sentence that names the one picked (else the nearest naming one).
        const nearest = Math.max(subject.naming, ...Object.values(subject.namedAt))
        keep(
          proved(item, {
            ...base,
            ...known,
            recordId: answered,
            pending: answered === null ? { kind: 'subject', candidates: subject.candidates } : null,
            subjectText: null,
            naming: answered === null ? nearest : (subject.namedAt[answered] ?? nearest)
          })
        )
        continue
      }
      if (verdict.r === null) {
        refuse('unconfirmed', item.claim, who)
        continue
      }
      if (verdict.r !== target?.expect) {
        refuse('subject', item.claim, who)
        continue
      }
      // First person counts for the typed POV only when the text's POV, verified, agrees, and
      // for a speaker only in what the checker confirms is their line or thought.
      if (subject.kind === 'firstPerson' && subject.via === 'pov' && textPov !== subject.recordId) {
        refuse('subject', item.claim, who)
        continue
      }
      if (
        subject.kind === 'firstPerson' &&
        subject.via === 'speaker' &&
        verdict.voice !== 'dialogue' &&
        verdict.voice !== 'thought'
      ) {
        refuse('subject', item.claim, who)
        continue
      }
      const known =
        item.recordId === null ? { how: null, fromId: null } : learnerLine(item.recordId)
      if (typeof known === 'string') {
        notHere(known, item, who)
        continue
      }
      keep(
        proved(item, {
          ...base,
          ...known,
          recordId: item.recordId,
          pending: namePending,
          subjectText
        })
      )
    }
    // A learner an on-page check showed joins the card's on-page list when the card is written,
    // its line's sentences joining the card's anchor.
    const shownAnchor: string[] = []
    if (merged !== null) {
      for (const fact of fresh) {
        const learner = fact.recordId
        if (fact.slot !== 'knows' || learner === null || !shownHere.has(learner)) continue
        if (cardPresent.some((entry) => entry.recordId === learner)) continue
        cardPresent.push({ recordId: learner, quote: fact.quote, p: fact.para, verified: true })
        shownAnchor.push(...fact.anchor)
      }
    }

    // 6. Reconcile and write, in one transaction.
    const readParas = new Set(
      pieces
        .flatMap((piece) => piece.paragraphs.map((part) => part.p))
        .filter((p) => !unread.has(p))
    )
    const wholeRead = full && unread.size === 0
    const mapIds = (shorts: readonly string[]): string[] =>
      shorts.flatMap((short) => {
        const id = claimIds.get(short.trim())
        return id === undefined ? [] : [id]
      })
    // A stored claim counts as refused only when the checker refused that very fact.
    const rejected = new Set(
      stored
        .filter((claim) =>
          rejectedQuotes.some(
            (entry) =>
              entry.recordId === claim.recordId &&
              entry.slot === claim.slot &&
              entry.quote === claim.quote &&
              entry.valueKey === claim.valueKey &&
              entry.voice === claim.voice &&
              entry.mode === claim.mode
          )
        )
        .map((claim) => claim.id)
    )
    const at0 = now()
    let readingId = ''
    const touched = new Set<string>()
    /** P2b: the secrets and threads made, merged into, revived, given up or pruned. */
    const topicIds = new Set<string>()
    const inserted: { id: string; proof: ClaimProof }[] = []
    let lineMoved = false
    // P2b-D9: whether the reading leaves nothing finished unread (the entries it will write), the
    // caret paragraph's finished sentences included (the idle trigger did not send them).
    const readEntries = nextReadSet(readSet, current, wholeRead ? 'all' : readParas)
    const finished =
      input.caretPara === null ? current : gateSentences(scene.texts, { caretPara: null, names })
    const settled = unreadSentences(finished, readSetOf(readEntries, names)).length === 0
    db.transaction((tx) => {
      readingId = insertReading(
        tx,
        {
          nodeId: input.nodeId,
          draftId,
          purpose,
          pages: requests,
          paras: ranges([...readParas]),
          promptVersion: READER_V3_PROMPT_VERSION,
          verifyVersion: spend.verifySent ? VERIFY_V3_PROMPT_VERSION : null,
          model: spend.model,
          tokensIn: spend.tokensIn,
          tokensOut: spend.tokensOut,
          reasoningTokens: spend.reasoning,
          costUsd: spend.costUsd,
          cloud: spend.cloud,
          finishReason: yields.cut > 0 ? 'length' : null,
          yields
        },
        at0
      )
      // No reply parsed: nothing was read, so only the reading and its cost are kept.
      if (answers.length === 0) return

      // The scene as it stands now: an edit saved while the requests were out (its anchors job
      // may already have run), or the scene made an Idea or left out of compile meanwhile.
      const sameDraft = currentDraftId(tx) === draftId
      const hashesNow = sameDraft
        ? sceneSentences(paragraphsOf(tx, input.nodeId).map((paragraph) => paragraph.text)).map(
            (sentence) => sentence.hash
          )
        : scene.hashes
      const moved =
        sameDraft &&
        (!readerMayRead(claimSources(tx)(input.nodeId)) ||
          hashesNow.length !== scene.hashes.length ||
          hashesNow.some((hash, i) => hash !== scene.hashes[i]))

      // P2b-D3, D4: the new topics, made silently or merged, before the facts that point at them.
      const made = new Map<string, { recordId: string; topicQuoteId: string | null }>()
      for (const topic of kept) {
        if (topic.dropped !== null) continue
        const quote: NewTopicQuote = {
          nodeId: input.nodeId,
          draftId,
          para: topic.p,
          quote: topic.q,
          label: topic.label,
          anchor: [...anchorFor(scene.sentences, topic.location)],
          stating: topic.stating,
          readingId
        }
        // Into an open topic, or into what an earlier page's new topic became.
        const target =
          topic.mergeInto === null
            ? null
            : topic.mergeInto.kind === 'listed'
              ? topic.mergeInto.recordId
              : (made.get(topic.mergeInto.key)?.recordId ?? null)
        if (target !== null) {
          const topicQuoteId = mergeInto(tx, target, quote, [], at0)
          made.set(topic.key, { recordId: target, topicQuoteId })
          topicIds.add(target)
          continue
        }
        const created = createTopic(
          tx,
          {
            kind: topic.kind,
            label: topic.label,
            quote,
            ref: () => order.refs.get(input.nodeId) ?? null
          },
          at0
        )
        made.set(topic.key, { recordId: created.recordId, topicQuoteId: null })
        topicIds.add(created.recordId)
      }
      // A knows line's secret is its object, a step's thread its record; one that came with a
      // merged reveal is tagged with it, so *Split* moves exactly those (P2b-D5).
      const pointed = fresh.map((fact) => {
        const key = freshTopic.get(fact)
        const target = key === undefined ? undefined : made.get(key)
        if (target === undefined) return fact
        return fact.slot === 'knows'
          ? { ...fact, objectId: target.recordId, topicQuoteId: target.topicQuoteId }
          : { ...fact, recordId: target.recordId, topicQuoteId: target.topicQuoteId }
      })

      const stillStored = sceneClaims(tx, input.nodeId, draftId)
      const result = reconcile({
        stored: stillStored,
        window: { paras: readParas, full: wholeRead, replace: rebuild && wholeRead },
        hashes: hashesNow,
        same: mapIds(answers.flatMap(({ answer }) => answer.same)),
        drop: mapIds(answers.flatMap(({ answer }) => answer.drop)),
        rejected,
        // A knows line or step is stored only with its topic (one whose topic was not made is not).
        fresh: pointed.filter(
          (fact) =>
            !(fact.slot === 'knows' && fact.objectId === null) &&
            !(fact.slot === 'thread' && fact.recordId === null)
        ),
        dismissed: dismissedKeys(tx, 'notRight'),
        movedTo: notAboutMovedTo(tx)
      })
      const ordered = [...result.inserts].sort(
        (a, b) =>
          a.para - b.para ||
          (scene.texts[a.para] ?? '').indexOf(a.quote) -
            (scene.texts[b.para] ?? '').indexOf(b.quote)
      )
      const inserts: NewClaim[] = ordered.map((claim) => ({
        nodeId: input.nodeId,
        draftId,
        readingId,
        recordId: claim.recordId,
        pending: claim.pending,
        subjectText: claim.subjectText,
        slot: claim.slot,
        value: claim.value,
        objectId: claim.objectId,
        voice: claim.voice,
        speakerId: claim.speakerId,
        mode: claim.mode,
        quote: claim.quote,
        para: claim.para,
        anchor: claim.anchor,
        proof: claim.proof,
        change: claim.change,
        state: claim.pending === null ? 'live' : 'waiting',
        how: claim.how,
        fromId: claim.fromId,
        topicQuoteId: claim.topicQuoteId
      }))
      const ids = insertClaims(tx, inserts, at0)
      for (const [i, id] of ids.entries()) {
        const fact = ordered[i]
        if (fact === undefined) continue
        inserted.push({ id, proof: fact.proof })
        const verdict = spotOf.get(fact)
        if (verdict !== undefined) setClaimSpot(tx, id, verdict, 'fast', at0)
      }
      for (const claim of inserts) {
        if (claim.recordId !== null) touched.add(claim.recordId)
        if (claim.slot === 'knows' && claim.objectId !== null) touched.add(claim.objectId)
      }
      const byId = new Map(stillStored.map((claim) => [claim.id, claim]))
      for (const revival of result.revivals) {
        reviveClaim(tx, revival.id, { ...revival, readingId }, at0)
        const recordId = byId.get(revival.id)?.recordId
        if (recordId !== null && recordId !== undefined) touched.add(recordId)
      }
      for (const id of result.deletes) {
        const recordId = byId.get(id)?.recordId
        if (recordId !== null && recordId !== undefined) touched.add(recordId)
      }
      deleteClaims(tx, result.deletes)
      // P2b: a restated reveal the checker passed revives its re-checking one; a re-checking
      // reveal in what was read and not revived goes (as a re-checking fact does, P2a-D23).
      const revivedIds = new Set<string>()
      for (const entry of revived) {
        reviveTopicQuote(
          tx,
          entry.quoteId,
          {
            para: entry.p,
            quote: entry.q,
            anchor: [...anchorFor(scene.sentences, entry.location)],
            stating: entry.stating,
            readingId
          },
          at0
        )
        revivedIds.add(entry.quoteId)
        topicIds.add(entry.recordId)
      }
      // On a whole rebuild read, a reveal the reading did not prove again goes too.
      const before = new Set(storedReveals.map((quote) => quote.id))
      const gone = sceneTopicQuotes(tx, input.nodeId, draftId).filter(
        (quote) =>
          before.has(quote.id) &&
          (quote.state === 'stale' || (rebuild && wholeRead)) &&
          !revivedIds.has(quote.id) &&
          (wholeRead || readParas.has(quote.para))
      )
      deleteTopicQuotes(
        tx,
        gone.map((quote) => quote.id)
      )
      for (const quote of gone) topicIds.add(quote.recordId)
      if (merged !== null) {
        const located = [
          ...Object.values(fields).flatMap((placed) => (placed === null ? [] : [placed])),
          ...presentEntries.map((entry) => entry.placed)
        ]
        const anchor = [
          ...new Set(
            located.flatMap((placed) =>
              placed.location.sentences.map(
                (i) => scene.hashes[scene.position(placed.field.p, i)] ?? ''
              )
            )
          )
        ].filter((hash) => hash !== '')
        for (const hash of shownAnchor) if (!anchor.includes(hash)) anchor.push(hash)
        const before = getCard(tx, input.nodeId, draftId)?.lineHash ?? null
        const line = capWords(merged.line, CARD_LINE_MAX_WORDS)
        lineMoved = before !== sha256(line)
        upsertCard(
          tx,
          {
            nodeId: input.nodeId,
            draftId,
            readingId,
            line,
            gist: capWords(merged.gist, CARD_GIST_MAX_WORDS),
            fields: cardFields,
            present: cardPresent,
            mood,
            theme,
            anchor,
            // What the card was made from: a card a retry gave never saw the paragraphs before it.
            seen: current
              .filter((sentence) => !unseenByCard.has(sentence.para))
              .map((sentence) => sentence.hash)
          },
          at0
        )
        for (const entry of cardPresent) touched.add(entry.recordId)
      }
      // P2b-D9: a topic reader read it (whole, for `topics_read`), and whether it is settled.
      writeSceneRead(
        tx,
        {
          nodeId: input.nodeId,
          draftId,
          entries: readEntries,
          full: wholeRead,
          readingId,
          topics: true,
          settled
        },
        at0
      )
      // What was written stands on the text as it was sent: check it against the text now, so a
      // fact whose sentences changed meanwhile goes stale (or re-proves) instead of staying live.
      if (moved) {
        const anchored = runAnchors(tx, input.nodeId, at0)
        const changed = new Set([...anchored.staled, ...anchored.parked])
        for (const claim of sceneClaims(tx, input.nodeId, draftId)) {
          if (changed.has(claim.id) && claim.recordId !== null) touched.add(claim.recordId)
        }
      }
      // P2b-D12: an AI-made topic nothing backs any more goes.
      for (const id of pruneTopics(tx)) topicIds.add(id)
    })
    return {
      read: true,
      readingId,
      purpose,
      pages: requests,
      costUsd: spend.costUsd,
      cut: yields.cut > 0,
      yields,
      recordIds: [...touched].sort(),
      names: [...waitingNames].sort(),
      inserted,
      model: spend.model,
      lineMoved,
      topicIds: [...topicIds].sort()
    }
  } catch (err) {
    if (err instanceof LocalCutoff) {
      return { read: false, reason: 'localCutoff', model: err.model, costUsd: spend.costUsd }
    }
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}
