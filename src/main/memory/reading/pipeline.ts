import { anchorFor } from '@shared/memory/anchor'
import {
  CARD_GIST_MAX_WORDS,
  CARD_LINE_MAX_WORDS,
  emptyCardFields,
  emptyYields,
  valueKey,
  type CardField,
  type CardFields,
  type CardPresent,
  type ClaimMode,
  type ClaimPending,
  type ClaimVoice,
  type ParaRange,
  type ReadingPurpose,
  type ReadingYields
} from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import {
  gateSentences,
  gateText,
  nextReadSet,
  readDecision,
  readSetOf,
  type GateSentence
} from '@shared/memory/gate'
import {
  nameInSentence,
  resolveSubject,
  type LadderReject,
  type LadderSentence,
  type SubjectResult
} from '@shared/memory/ladder'
import { literalProof, type LiteralName } from '@shared/memory/literal'
import { countNameSpans } from '@shared/memory/nameQuestions'
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
import { twinGate } from '@shared/memory/twinGate'
import { cardDue, outputCap, planPages, planWindows, type ReadPiece } from '@shared/memory/windows'
import { activeDraftId } from '../../draft/draftStore'
import { READER_PROMPT_VERSION, buildReaderPrompt } from '../../ai/prompts/reader.v1'
import {
  VERIFY_PROMPT_VERSION,
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
import { getCard, upsertCard } from './cardStore'
import {
  claimSources,
  deleteClaims,
  draftClaims,
  insertClaims,
  reviveClaim,
  sceneClaims,
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
 *    to its last complete item and the paragraphs after the last one it quoted are read once more.
 * 5. **Ladder**, per item: presence (the quote once in the window, in its paragraph), subject
 *    (`resolveSubject`: a name pins it, a pronoun goes to the checker, first person only to the
 *    speaker or the typed POV), literal proof in code, then `verify.v1` (one batch per page) for
 *    the rest, the card's POV, year and flashback, and who is on the page. Only what is proved is
 *    kept; every rejection is counted by reason in the reading's yields.
 * 6. **Reconcile** (`reconcile.ts`) and write, in one transaction: the reading row (cost = reader
 *    + verify), the claims, the card, the read set.
 * 7. **New names** go through the twin gate: a name the author would be asked about keeps its
 *    proved facts `waiting` on the name (P2a-D7: no record is made silently); a dismissed one is
 *    dropped with them.
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
  /** A rebuild reads the whole scene whatever the gate says (slice 3). */
  purpose?: Extract<ReadingPurpose, 'rebuild'>
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
      requestId: request.childId
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
  /** Short ids the checker may answer for a pronoun or a new name, to the record (or name) each means. */
  ids: Map<string, string>
}

/** A card field located in the window and in its paragraph. */
interface PlacedField {
  field: ReaderCardField
  location: QuoteLocation
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

/** The sentences ±1 around positions `from`..`to` (and from `naming` when it stands earlier). */
function contextText(scene: ReadingScene, from: number, to: number, naming?: number): string {
  const start = Math.max(0, Math.min(from - 1, naming ?? from - 1))
  const end = Math.min(scene.sentences.length - 1, to + 1)
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

/** The merged card of a reading's pages: the first page's line and gist, the first value per field. */
function mergeCards(cards: readonly ReaderCard[]): ReaderCard | null {
  const [first, ...rest] = cards
  if (first === undefined) return null
  const merged: ReaderCard = { ...first, present: [...first.present] }
  for (const card of rest) {
    merged.where ??= card.where
    merged.when ??= card.when
    merged.year ??= card.year
    merged.elapsed ??= card.elapsed
    merged.pov ??= card.pov
    merged.flash ??= card.flash
    merged.mood ??= card.mood
    merged.theme ??= card.theme
    for (const entry of card.present) {
      if (!merged.present.some((other) => other.value === entry.value)) merged.present.push(entry)
    }
  }
  return merged
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

/** Reads one scene (see the module comment). */
export async function runReading(
  db: TreeDb,
  deps: ReadingDeps,
  input: RunReadingInput
): Promise<ReadingOutcome> {
  const now = (): Date => deps.ai.now()
  if (!readerMayRead(claimSources(db)(input.nodeId))) return { read: false, reason: 'notReadable' }
  const scene = loadReadingScene(db, input.nodeId)
  if (scene === null) return { read: false, reason: 'notReadable' }
  const draftId = activeDraftId(db)
  const names = scene.shared.index

  // 1. The gate.
  const current: GateSentence[] = gateSentences(scene.texts, { caretPara: input.caretPara, names })
  const previous = getSceneRead(db, input.nodeId, draftId)
  const readSet = previous === null ? null : readSetOf(previous.entries, names)
  const stored = sceneClaims(db, input.nodeId, draftId)
  const card = getCard(db, input.nodeId, draftId)
  const present = new Set(scene.hashes)
  const decision = readDecision({
    sentences: current,
    read: readSet,
    partials: previous?.partials ?? 0,
    staleParas: new Set(stored.filter((claim) => claim.state === 'stale').map((c) => c.para)),
    cardStale: card?.anchor.some((hash) => !present.has(hash)) === true,
    knownWords: knownWords(db, input.nodeId, scene.shared)
  })
  const rebuild = input.purpose === 'rebuild'
  if (decision.read === 'nothing' && !(rebuild && current.length > 0)) {
    return { read: false, reason: decision.reason }
  }
  const full = rebuild || decision.read === 'full'
  const purpose: ReadingPurpose = rebuild
    ? 'rebuild'
    : decision.read === 'full'
      ? decision.reason === 'first'
        ? 'first'
        : 'full'
      : 'window'

  // 2. The plan.
  const pieces = full
    ? planPages(scene.texts)
    : planWindows(scene.texts, decision.read === 'window' ? decision.paras : [], namingParas(scene))
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
    const unread = new Set<number>()
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
        // Only the paragraphs after the last one quoted are read again, once.
        const last = lastQuoted(first.answer)
        const rest = piece.paragraphs.filter((part) => part.p > last)
        if (rest.length > 0) {
          const again = await ask(rest)
          if (again.cut) yields.cut += 1
          answer =
            answer === null
              ? again.answer
              : again.answer === null
                ? answer
                : mergeAnswers(answer, again.answer)
          if (again.cut) {
            const reached = lastQuoted(again.answer)
            for (const part of rest) if (part.p > reached) unread.add(part.p)
          }
        }
      }
      if (answer === null) {
        reject('unparsed')
        continue
      }
      for (let i = 0; i < answer.dropped; i += 1) reject('shape')
      answers.push({ piece: index, answer })
    }

    // 5. The ladder.
    const dismissedNameKeys = new Set(dismissedNames(db))
    const aliasDismissals = dismissedKeys(db, 'alias')
    const twinRoster = rosterOf(db)
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
      about: { recordId: string } | { name: { norm: string; text: string } }
    ): void => {
      yields.items += 1
      const who = {
        recordId: 'recordId' in about ? about.recordId : null,
        name: 'name' in about ? about.name.text : null
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
        value: claim.v.trim(),
        check: null
      }
      let literalNames: (sentence: LadderSentence) => readonly LiteralName[] = (s) => s.names
      if ('recordId' in about) {
        item.subject = resolveSubject({
          recordId: about.recordId,
          voice: claim.voice,
          speakerId,
          quote,
          before,
          typedPov: scene.details.povRecordId,
          isCharacter
        })
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
        const owner = owners.length === 1 ? owners[0] : undefined
        if (owner !== undefined) {
          // A name the roster has after all: its facts are that record's.
          for (const claim of named.c) ladder(piece, claim, { recordId: owner.id })
          continue
        }
        const spans = countNameSpans(scene.texts[named.p] ?? '')
        const gate = twinGate(named.n, twinRoster, [...dismissedNameKeys])
        const refused =
          !spans.has(norm) ||
          dismissedNameKeys.has(dismissedKey({ kind: 'name', name: named.n })) ||
          (gate.outcome === 'blocked' &&
            (gate.recordId === null ||
              aliasDismissals.has(
                dismissedKey({ kind: 'alias', recordId: gate.recordId, alias: named.n })
              )))
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

    // The card: its fields located in the window; POV, year, flashback and presence to the checker.
    const readerCards = answers.flatMap(({ answer }) => (answer.card === null ? [] : [answer.card]))
    const merged = due ? mergeCards(readerCards) : null
    const cardPiece = answers.find(({ answer }) => answer.card !== null)?.piece ?? 0
    const place = (field: ReaderCardField | null): PlacedField | null => {
      if (field === null) return null
      const location = locate(scene, texts[cardPiece] ?? [], field.p, field.q)
      return typeof location === 'string' ? null : { field, location }
    }
    const fields = {
      where: place(merged?.where ?? null),
      when: place(merged?.when ?? null),
      year: place(merged?.year ?? null),
      elapsed: place(merged?.elapsed ?? null),
      pov: place(merged?.pov ?? null),
      flashback: place(merged?.flash ?? null)
    }
    const povRecord = fields.pov === null ? null : roster.recordOf(fields.pov.field.value)
    if (povRecord === null || !isCharacter(povRecord)) fields.pov = null
    const presentEntries = (merged?.present ?? []).flatMap((entry) => {
      const recordId = roster.recordOf(entry.value)
      const placed = place(entry)
      return recordId !== null && placed !== null && isCharacter(recordId)
        ? [{ recordId, placed }]
        : []
    })

    // The checker: one batch per page.
    const checks: Check[] = []
    const around = (location: QuoteLocation, p: number, naming?: number): string => {
      const quoted = location.sentences.map((i) => scene.position(p, i))
      return contextText(scene, Math.min(...quoted), Math.max(...quoted), naming)
    }
    for (const [index, item] of items.entries()) {
      if (item.proof === 'literal') continue
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
      const who =
        subject.kind === 'newName'
          ? [`n1 ${subject.text} (a name not on the roster)`]
          : candidates.map((id) => {
              ids.set(roster.shortOf(id), id)
              return roster.whoLine(id)
            })
      if (subject.kind === 'newName') ids.set('n1', `name:${item.name?.norm ?? ''}`)
      item.check = checks.length
      yields.verifySent += 1
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
        piece: cardPiece,
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
        piece: cardPiece,
        target: { kind: 'present', index },
        ids: new Map()
      })
    }

    const verdicts = new Map<number, VerifyVerdict>()
    let batchNo = 0
    for (let piece = 0; piece < pieces.length; piece += 1) {
      const own = checks
        .map((check, index) => ({ check, index }))
        .filter((entry) => entry.check.piece === piece)
      for (const batch of verifyBatches(
        own.map((entry) => ({ ...entry.check, at: entry.index }))
      )) {
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
    const rejectedQuotes: { recordId: string | null; slot: Slot; quote: string }[] = []
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
        keep(
          proved(item, {
            recordId: item.recordId,
            pending: namePending,
            subjectText,
            voice: item.claim.voice,
            mode: item.claim.mode,
            proof: 'literal'
          })
        )
        continue
      }
      const verdict = item.check === null ? undefined : verdicts.get(item.check)
      const check = item.check === null ? undefined : checks[item.check]
      if (verdict === undefined || !verdict.ok || check === undefined) {
        refuse('unsupported', item.claim, who)
        rejectedQuotes.push({ recordId: item.recordId, slot: item.slot, quote: item.claim.q })
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
        // More than one fits (null): it waits, and the next full read drops it (P2a-D23).
        keep(
          proved(item, {
            ...base,
            recordId: answered,
            pending: answered === null ? { kind: 'subject', candidates: subject.candidates } : null,
            subjectText: null,
            naming: subject.naming
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
      // First person counts for the typed POV only when the text's POV, verified, agrees.
      if (subject.kind === 'firstPerson' && subject.via === 'pov' && textPov !== subject.recordId) {
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
    const rejected = new Set(
      stored
        .filter((claim) =>
          rejectedQuotes.some(
            (entry) =>
              entry.recordId === claim.recordId &&
              entry.slot === claim.slot &&
              entry.quote === claim.quote
          )
        )
        .map((claim) => claim.id)
    )
    const at0 = now()
    const writtenCard = merged !== null
    let readingId = ''
    const touched = new Set<string>()
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
      const stillStored = sceneClaims(tx, input.nodeId, draftId)
      const result = reconcile({
        stored: stillStored,
        window: { paras: readParas, full: wholeRead },
        hashes: scene.hashes,
        same: mapIds(answers.flatMap(({ answer }) => answer.same)),
        drop: mapIds(answers.flatMap(({ answer }) => answer.drop)),
        rejected,
        fresh,
        dismissed: dismissedKeys(tx, 'notRight')
      })
      const inserts: NewClaim[] = [...result.inserts]
        .sort(
          (a, b) =>
            a.para - b.para ||
            (scene.texts[a.para] ?? '').indexOf(a.quote) -
              (scene.texts[b.para] ?? '').indexOf(b.quote)
        )
        .map((claim) => ({
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
      insertClaims(tx, inserts, at0)
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
      if (writtenCard && merged !== null) {
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
            mood: merged.mood,
            theme: merged.theme,
            anchor,
            seen: current.map((sentence) => sentence.hash)
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
          full,
          readingId
        },
        at0
      )
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
      names: [...waitingNames].sort()
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
