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
import {
  gateSentences,
  gateText,
  nextReadSet,
  readDecision,
  readSetOf,
  unreadSentences,
  type GateSentence,
  type ReadDecision,
  type ReadSentence
} from '@shared/memory/gate'
import {
  nameInSentence,
  resolveSubject,
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
import { OBJECT_SLOTS, parseSlot, readerAccepts, type Slot } from '@shared/memory/slots'
import { readerMayRead } from '@shared/memory/sources'
import { spotPicked } from '@shared/memory/spot'
import { cardDue, outputCap, planPages, planWindows, type ReadPiece } from '@shared/memory/windows'
import { activeDraftId, currentDraftId } from '../../draft/draftStore'
import { READER_PROMPT_VERSION, buildReaderPrompt } from '../../ai/prompts/reader.v1'
import {
  VERIFY_PROMPT_VERSION,
  VERIFY_UNNAMED_MARK,
  buildVerifyPrompt,
  verifyBatches,
  type VerifyPromptItem
} from '../../ai/prompts/verify.v1'
import { cancelInflight } from '../../ai/inflight'
import { runAiRequest, sha256, type AiRequestDeps, type AiRequestResult } from '../../ai/request'
import { AiCancelledError, type AiMessage } from '../../ai/providers/types'
import type { TreeDb } from '../../tree/treeStore'
import { dismissedKeys } from '../dismissedStore'
import { dismissedNames, rosterOf } from '../recordStore'
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
  knownWords,
  loadReadingScene,
  namingParas,
  nearLines,
  positionLine,
  typedLine,
  type ReadingScene
} from './readerContext'
import { insertReading } from './readingStore'
import { readerRoster, type ReaderRoster } from './rosterCache'
import { getSceneRead, writeSceneRead } from './sceneReadStore'
import { readingOrder } from './views'

/**
 * The reading pipeline (F-16.17, F-16.16's gate; design §2.3, plan P2a §2.4): `runReading` reads
 * one scene of the active draft when the gate says something changed, and keeps only what the
 * prose is proved to state.
 *
 * 1. **Gate** (`readDecision`): nothing unread, or only cosmetic edits → nothing is sent.
 * 2. **Plan**: the window (changed paragraphs ±2, back to a naming paragraph) or the whole scene
 *    in pages; whether the card is due.
 * 3. **Prompt** (`reader.v1`): the cached roster, the scene's head, the facts known near the
 *    window and anchored in it, the numbered paragraphs; the context hash covers every message,
 *    so an identical request answers from the local cache (token rule 4).
 * 4. **Request** through `runAiRequest` (feature `reader`, fast, JSON, reasoning off): the daily
 *    cap, the budgets and the ledger are the request path's. A reply cut off at its cap is read
 *    to its last complete item and the paragraphs after the last one it quoted are read once more
 *    (the whole piece when it listed its facts out of paragraph order). A piece whose reply does
 *    not parse stays unread: nothing in it is treated as read.
 * 5. **Ladder**, per item: presence (the quote once in the window, in its paragraph), subject
 *    (`resolveSubject`: a name pins it, a pronoun goes to the checker with every character named
 *    in reach, first person only to the speaker or the typed POV), literal proof in code, then
 *    `verify.v1` (batches per page, each sized so its verdicts fit; a batch cut off at its cap has
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
    promptVersion: typeof READER_PROMPT_VERSION | typeof VERIFY_PROMPT_VERSION
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

/** The ladder's work on one proposed fact. */
interface Item {
  /** Where it came from: the piece and the paragraph texts sent with it. */
  piece: number
  claim: ReaderClaim
  slot: Slot
  /** The record it is about (null for a fact about a new name). */
  recordId: string | null
  /** The new name it is about. */
  name: { norm: string; text: string } | null
  objectId: string | null
  speakerId: string | null
  location: QuoteLocation
  quote: LadderSentence[]
  subject: SubjectResult | { kind: 'newName'; text: string }
  proof: 'literal' | null
  /** A literal claim picked for a fast spot check: its check's index. */
  spotCheck: number | null
  value: string
  /** The verify item for it, when one was sent. */
  check: number | null
}

/** A verify item, with what it checks. */
interface Check extends VerifyPromptItem {
  piece: number
  /** The item, card field or present entry it checks. */
  target:
    | { kind: 'item'; index: number; expect: string | null; candidates: string[] }
    | { kind: 'card'; field: 'pov' | 'year' | 'flashback' }
    | { kind: 'present'; index: number }
    /** A literal claim's fast spot check (P2a-D8): counted, never refusing the claim. */
    | { kind: 'spot'; index: number; expect: string }
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

/** The fact as the checker reads it ("location: the quay (narration, now)"). */
function factText(item: Item, roster: ReaderRoster): string {
  const object = item.objectId === null ? '' : ` (of ${roster.shortOf(item.objectId)})`
  const by =
    item.speakerId !== null && (item.claim.voice === 'dialogue' || item.claim.voice === 'thought')
      ? ` by ${roster.shortOf(item.speakerId)}`
      : ''
  return `${item.slot}: ${item.claim.v}${object} (${item.claim.voice}${by}, ${item.claim.mode})`
}

/** A stored claim as a spot check sends it: the checker's item, and the record it must answer. */
export interface ClaimCheck extends VerifyPromptItem {
  expect: string
}

/**
 * A stored claim as the checker reads it (the spot checks, F-16.17): its record's roster line,
 * the fact, and its quote's sentences ±`around`; null when its quote is no longer in its
 * paragraph (its anchor will say so) or it has no record yet.
 */
export function claimCheck(
  scene: ReadingScene,
  claim: Claim,
  roster: ReaderRoster,
  around: number
): ClaimCheck | null {
  if (claim.recordId === null) return null
  const only = scene.texts.map((text, i) => (i === claim.para ? text : ''))
  const location = locateQuote(only, claim.para, claim.quote)
  if (!location.ok) return null
  const quoted = location.sentences.map((i) => scene.position(claim.para, i))
  const object = claim.objectId === null ? '' : ` (of ${roster.shortOf(claim.objectId)})`
  const by =
    claim.speakerId !== null && (claim.voice === 'dialogue' || claim.voice === 'thought')
      ? ` by ${roster.shortOf(claim.speakerId)}`
      : ''
  return {
    kind: 'claim',
    who: [roster.whoLine(claim.recordId)],
    fact: `${claim.slot}: ${claim.value}${object} (${claim.voice}${by}, ${claim.mode})`,
    text: contextText(scene, Math.min(...quoted), Math.max(...quoted), undefined, around),
    expect: roster.shortOf(claim.recordId)
  }
}

/** Whether a verdict agrees with a fact as stated: supported, about that record, voice and mode. */
export function agrees(
  verdict: VerifyVerdict,
  fact: { expect: string; voice: ClaimVoice; mode: ClaimMode }
): boolean {
  return (
    verdict.ok &&
    verdict.r === fact.expect &&
    verdict.voice === fact.voice &&
    verdict.mode === fact.mode
  )
}

/** Merges two answers of one piece (a cut-off reply and its retry). */
function mergeAnswers(a: ReaderAnswer, b: ReaderAnswer): ReaderAnswer {
  return {
    claims: [...a.claims, ...b.claims],
    names: [...a.names, ...b.names],
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
    ...answer.names.flatMap((name) => [name.p, ...name.c.map((claim) => claim.p)])
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
 * reader may not read the scene (an Idea, left out of compile, not in the manuscript).
 */
export function gateScene(db: TreeDb, nodeId: string, caretPara: number | null): SceneGate | null {
  if (!readerMayRead(claimSources(db)(nodeId))) return null
  const scene = loadReadingScene(db, nodeId)
  if (scene === null) return null
  const draftId = activeDraftId(db)
  const names = scene.shared.index
  const current: GateSentence[] = gateSentences(scene.texts, { caretPara, names })
  const previous = getSceneRead(db, nodeId, draftId)
  const readSet = previous === null ? null : readSetOf(previous.entries, names)
  const stored = sceneClaims(db, nodeId, draftId)
  const card = getCard(db, nodeId, draftId)
  const present = new Set(scene.hashes)
  // The known words cost a pass over the manuscript: read only when an edit could be cosmetic.
  const unread = readSet === null ? [] : unreadSentences(current, readSet)
  const decision = readDecision({
    sentences: current,
    read: readSet,
    partials: previous?.partials ?? 0,
    staleParas: new Set(stored.filter((claim) => claim.state === 'stale').map((c) => c.para)),
    cardStale: card?.anchor.some((hash) => !present.has(hash)) === true,
    knownWords: unread.length > 0 ? knownWords(db, nodeId, scene.shared) : new Set<string>()
  })
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

  // 2. The plan.
  const windowParas = backfill
    ? backfillParas
    : decision.read === 'window'
      ? decision.paras
      : []
  const pieces = full
    ? planPages(scene.texts)
    : planWindows(scene.texts, windowParas, namingParas(scene))
  if (pieces.length === 0) return { read: false, reason: 'empty' }
  const due = cardDue({ card, full, present, finished: current.map((s) => s.hash) })

  const roster = readerRoster(db)
  const order = readingOrder(db)
  const at = order.at.get(input.nodeId) ?? Number.MAX_SAFE_INTEGER
  const draft = draftClaims(db, draftId).filter(
    (claim) => (order.at.get(claim.nodeId) ?? Number.MAX_SAFE_INTEGER) <= at
  )
  const yields = emptyYields()
  const reject = (reason: LadderReject | 'unparsed'): void => {
    yields.rejected += 1
    yields.rejections[reason] = (yields.rejections[reason] ?? 0) + 1
  }
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
        claimIds.set(short, claim.id)
        anchored.push(anchoredLine(short, claim, roster))
      }
      const named = [
        ...new Set(
          scene.mentions
            .filter((mention) => !mention.ambiguous && paras.has(mention.para))
            .map((mention) => mention.recordId)
        )
      ]
      const withCard = due && (full || index === 0)
      const base = {
        roster: roster.lines,
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
        maxTokens: outputCap({
          purpose: full ? 'full' : 'window',
          proseTokens: piece.tokens,
          cardDue: withCard
        })
      }
      const ask = async (
        parts: ReadPiece['paragraphs']
      ): Promise<{ answer: ReaderAnswer | null; cut: boolean }> => {
        const prompt = buildReaderPrompt({
          ...base,
          paragraphs: parts.map((part) => ({ p: part.p, text: texts[part.p] ?? '' }))
        })
        requests += 1
        const result = await send(deps, input, spend, inFlight, {
          feature: 'reader',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          childId: `${input.requestId}:r${requests}`,
          promptVersion: READER_PROMPT_VERSION
        })
        return { answer: parseReaderAnswer(result.text), cut: result.finishReason === 'length' }
      }
      const first = await ask(piece.paragraphs)
      let answer = first.answer
      if (first.cut) {
        yields.cut += 1
        // Only the paragraphs after the last one quoted are read again, once (all of them when
        // the reply did not keep to paragraph order, so where it stopped says nothing).
        const last = reachedOf(first.answer)
        const rest = piece.paragraphs.filter((part) => part.p > last)
        if (rest.length > 0) {
          const again = await ask(rest)
          if (again.cut) yields.cut += 1
          if (again.answer === null) {
            // A retry that does not parse reads nothing: its paragraphs stay unread.
            for (const part of rest) unread.add(part.p)
          } else {
            if (again.cut) {
              const reached = reachedOf(again.answer)
              for (const part of rest) if (part.p > reached) unread.add(part.p)
            }
            // The card comes last in a reply: one only the retry gave saw only its paragraphs.
            if ((answer?.card ?? null) === null && again.answer.card !== null) {
              const seen = new Set(rest.map((part) => part.p))
              for (const part of piece.paragraphs) if (!seen.has(part.p)) unseenByCard.add(part.p)
            }
            answer = answer === null ? again.answer : mergeAnswers(answer, again.answer)
          }
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
    const askAbout = nameAsker(twinRoster, {
      names: dismissedNames(db),
      aliasKeys: dismissedKeys(db, 'alias')
    })
    const isCharacter = (id: string): boolean => scene.kindOf(id) === 'character'
    const items: Item[] = []
    const waitingNames = new Set<string>()
    const texts = pieces.map((piece) => sentTexts(scene, piece))
    const positions = pieces.map((piece) => sentPositions(scene, piece))

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

    const ladder = (
      piece: number,
      claim: ReaderClaim,
      about:
        | { recordId: string }
        | { name: { norm: string; text: string } }
        /** A name two or more records share: its sentence must name one, or wait on them all. */
        | { owners: string[]; text: string }
    ): void => {
      yields.items += 1
      const who = {
        recordId: 'recordId' in about ? about.recordId : null,
        name: 'name' in about ? about.name.text : 'owners' in about ? about.text : null
      }
      const slot = parseSlot(claim.s)
      if (slot === null || !readerAccepts(slot)) return refuse('slot', claim, who)
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
        OBJECT_SLOTS.includes(slot) && claim.o !== null ? roster.recordOf(claim.o) : null
      const item: Item = {
        piece,
        claim,
        slot,
        recordId: 'recordId' in about ? about.recordId : null,
        name: 'name' in about ? about.name : null,
        objectId,
        speakerId,
        location,
        quote,
        subject: { kind: 'none' },
        proof: null,
        spotCheck: null,
        value: claim.v.trim(),
        check: null
      }
      let literalNames: (sentence: LadderSentence) => readonly LiteralName[] = (s) => s.names
      const resolve = (recordId: string): SubjectResult =>
        resolveSubject({
          recordId,
          voice: claim.voice,
          speakerId,
          quote,
          before,
          typedPov: scene.details.povRecordId,
          isCharacter
        })
      if ('recordId' in about) {
        item.subject = resolve(about.recordId)
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
      const single = quote.length === 1 ? quote[0] : undefined
      const span = scene.spans[claim.p]?.[location.sentences[0] ?? -1]
      if (
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

    for (const { piece, answer } of answers) {
      for (const claim of answer.claims) {
        const recordId = claim.r === null ? null : roster.recordOf(claim.r)
        if (recordId === null) {
          yields.items += 1
          refuse('record', claim, { recordId: null, name: null })
          continue
        }
        ladder(piece, claim, { recordId })
      }
      for (const named of answer.names) {
        const norm = normName(named.n)
        const owners = twinRoster.filter((record) =>
          record.names.some((text) => normName(text) === norm)
        )
        const [owner, ...others] = owners
        if (owner !== undefined) {
          // A name the roster has after all: its facts are that record's, or, when records share
          // it, the one the sentence settles (else they wait on all of them, P2a-D22).
          for (const claim of named.c) {
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
          for (const claim of named.c) {
            yields.items += 1
            refuse('name', claim, { recordId: null, name: named.n })
          }
          continue
        }
        for (const claim of named.c) ladder(piece, claim, { name: { norm, text: named.n } })
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
      item.check = checks.length
      checks.push({
        kind: 'claim',
        who,
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
          candidates
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
    for (const [index, entry] of presentEntries.entries()) {
      checks.push({
        kind: 'present',
        who: [roster.whoLine(entry.recordId)],
        fact: `${roster.shortOf(entry.recordId)} is on the page in this scene (present, not only named or remembered)`,
        text: around(entry.placed.location, entry.placed.field.p),
        piece: entry.placed.piece,
        target: { kind: 'present', index },
        ids: new Map()
      })
    }

    const verdicts = new Map<number, VerifyVerdict>()
    let batchNo = 0
    /** Sends one batch and keeps its verdicts; true when the reply was cut off at its cap. */
    const runBatch = async (batch: readonly (Check & { at: number })[]): Promise<boolean> => {
      batchNo += 1
      const prompt = buildVerifyPrompt({ items: batch })
      const result = await send(deps, input, spend, inFlight, {
        feature: 'verify',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        childId: `${input.requestId}:v${batchNo}`,
        promptVersion: VERIFY_PROMPT_VERSION
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
      for (const batch of verifyBatches(own)) {
        if (!(await runBatch(batch))) continue
        yields.cut += 1
        // The items a cut-off reply did not reach are asked once more.
        const missing = batch.filter((entry) => !verdicts.has(entry.at))
        for (const again of verifyBatches(missing)) {
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

    // The claims' verdicts.
    const fresh: FreshClaim[] = []
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
      }
    ): FreshClaim => {
      const anchor = [...anchorFor(scene.sentences, item.location, at.naming)]
      const speakerId = at.voice === 'dialogue' || at.voice === 'thought' ? item.speakerId : null
      return {
        recordId: at.recordId,
        pending: at.pending,
        subjectText: at.subjectText,
        slot: item.slot,
        value: item.value,
        valueKey: valueKey(item.value),
        objectId: item.objectId,
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
        // next full read drops it (P2a-D23).
        if (answered === null && subject.candidates.length < 2) {
          refuse('unconfirmed', item.claim, who)
          continue
        }
        // The anchor keeps the sentence that names the one picked (else the nearest naming one).
        const nearest = Math.max(subject.naming, ...Object.values(subject.namedAt))
        keep(
          proved(item, {
            ...base,
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
      keep(proved(item, { ...base, recordId: item.recordId, pending: namePending, subjectText }))
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
    const inserted: { id: string; proof: ClaimProof }[] = []
    db.transaction((tx) => {
      readingId = insertReading(
        tx,
        {
          nodeId: input.nodeId,
          draftId,
          purpose,
          pages: requests,
          paras: ranges([...readParas]),
          promptVersion: READER_PROMPT_VERSION,
          verifyVersion: spend.verifySent ? VERIFY_PROMPT_VERSION : null,
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

      const stillStored = sceneClaims(tx, input.nodeId, draftId)
      const result = reconcile({
        stored: stillStored,
        window: { paras: readParas, full: wholeRead, replace: rebuild && wholeRead },
        hashes: hashesNow,
        same: mapIds(answers.flatMap(({ answer }) => answer.same)),
        drop: mapIds(answers.flatMap(({ answer }) => answer.drop)),
        rejected,
        fresh,
        dismissed: dismissedKeys(tx, 'notRight')
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
          state: claim.pending === null ? 'live' : 'waiting'
        }))
      const ids = insertClaims(tx, inserts, at0)
      for (const [i, id] of ids.entries()) {
        const fact = ordered[i]
        if (fact === undefined) continue
        inserted.push({ id, proof: fact.proof })
        const verdict = spotOf.get(fact)
        if (verdict !== undefined) setClaimSpot(tx, id, verdict, 'fast', at0)
      }
      for (const claim of inserts) if (claim.recordId !== null) touched.add(claim.recordId)
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
        upsertCard(
          tx,
          {
            nodeId: input.nodeId,
            draftId,
            readingId,
            line: capWords(merged.line, CARD_LINE_MAX_WORDS),
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
      writeSceneRead(
        tx,
        {
          nodeId: input.nodeId,
          draftId,
          entries: nextReadSet(readSet, current, wholeRead ? 'all' : readParas),
          full: wholeRead,
          readingId
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
      model: spend.model
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
