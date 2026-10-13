import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS, type Tier } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { RouteDecision } from '@shared/assistantRoute'
import type { InvariantCitation } from '@shared/memory/invariants'
import type { InstantCard, Navigation } from '@shared/scribe'
import { parseCitedAnswer, quoteHeld, statesAbsenceAsFact, statesScope } from '@shared/scribeAnswer'
import { card, claim, reading } from '../../db/schema'
import { indexOwner, indexScene } from '../../memory/passageIndexer'
import { runAnchors } from '../../memory/reading/anchors'
import { getClaim } from '../../memory/reading/claimStore'
import { runReading } from '../../memory/reading/pipeline'
import { fakeAi, requestKind } from '../../memory/reading/readingFixture'
import { listRecords } from '../../memory/recordStore'
import type { LabelQuestion, QuestionKind } from '../../memory/testBook/labels.schema'
import { QUESTION_KINDS } from '../../memory/testBook/labels.schema'
import {
  addTestBookPages,
  buildTestBookProject,
  editTestBook,
  type TestBookProject
} from '../../memory/testBook/project'
import { setAiSettings } from '../../project/settingsStore'
import { runNavigate, type NavigateReader } from '../../scribe/navigate'
import { searchMisses } from '../../scribe/searchMissStore'
import { PIN_NOT_ASKED, runScribe, type ScribeResult } from '../../scribe/runScribe'
import { replyObject } from '../agent'
import { AGENT_V9_SENTINEL } from '../prompts/agent.v9'
import { parseCiteReply } from '../prompts/cite.v1'
import { NAVIGATOR_SENTINEL } from '../prompts/navigator.v1'
import type { AiMessage, Provider, StreamChunk } from '../providers/types'
import type { UsageEntry } from '../usageStore'
import { fakeChatServer, type ChatServer } from './fakeChatServer'
import {
  liveProviderError,
  liveProviderFromEnv,
  liveRequestDeps,
  type LiveProvider,
  type LiveRequestDeps
} from './liveProvider'
import {
  invariants,
  oracleRead,
  oracleVerify,
  readBook,
  readingStop,
  sceneOf
} from './memoryOracle'
import {
  SCRIBE_QUESTIONS,
  answerEvidence,
  answerTail,
  citeMarker,
  findQuoted,
  namesRef,
  navigatorMenu,
  oracleCiteReply,
  quoteAround,
  sceneRef,
  scribeOracleReply,
  scribeOracleServer,
  scribeRequestKind,
  searchedPhrase,
  type ScribePlants,
  type ScribeRequestKind
} from './scribeOracle'

/**
 * Ms Scribe over the test book (F-16.24, F-16.25, F-16.26; plan P3 §6.2, §6.3), `npm run eval:ai`
 * (and so `npm run test`):
 *
 * - The **oracle replay**: the test book read by P2a/P2b's oracle (`memoryOracle.ts`), so the
 *   memory is the labelled one, its labelled record pages and the author's late edit made, then
 *   every labelled question (`TEST_BOOK_LABELS.questions`) through the real path the chat takes
 *   (`runNavigate`, then `runScribe` with the navigation in Ask, or Plan where labelled), with the
 *   oracle navigator, answer and checker (`scribeOracle.ts`) behind a fake OpenRouter
 *   (`fakeChatServer`) reached from `OPENROUTER_API_KEY` alone. Instant questions send nothing;
 *   stale and contested values are lookups with no navigator request; routes are the labels' (F-5.26
 *   kept); every answer cites the labelled passage, quote and sentence checked; ordinal answers
 *   searched every earlier scene; ideas are labelled; not-found questions end not found with what
 *   was looked in; no request carries an absence; sheet lines land where asked; the invariants
 *   hold, and no claim, card or reading is written.
 * - The **adversarial replay**: planted replies (a card cited, a quote not in its item, a "first"
 *   with an earlier passage, a sheet line nobody asked for, a second need, navigator prose), each
 *   caught as the plan says.
 * - The **live Ms Scribe run** (`MYTHSCRIBE_EVAL_LIVE=1`; owed by the author before the
 *   switch-over; it cannot run in the build sessions, which have no key):
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- scribe
 *       MYTHSCRIBE_EVAL_LIVE=1 MYTHSCRIBE_EVAL_READ=live OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- scribe
 *
 *   One pass over the test book with the real `navigator.v1`, `agent.v9` and `cite.v1` (V4 Flash,
 *   V4 Pro), its memory read by the oracle (the second form reads it with the real `reader.v2` and
 *   `verify.v2` first, about 13¢ more; vitest refuses unknown flags, so `--read live` is an
 *   environment variable), scored by the same functions against the pass bars (`SCRIBE_PASS_BARS`,
 *   P3-D20). It stops once the reported cost passes $1 (about 40¢ expected) and writes
 *   `test-results/eval-scribe/scribe-<date>.md` and `.json` (no prompt text, no key).
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const fail = (): never => {
  throw new Error('the replay did not run')
}

/** The live run's pass bars (decided by Claude, unconfirmed; P3-D20). */
export const SCRIBE_PASS_BARS = {
  routing: 0.9,
  correctness: 0.8,
  citationValidity: 0.9,
  scopeHonesty: 1,
  notFoundHonesty: 1,
  /** Answers saying someone does not know something without what was searched. */
  absenceAsFact: 0,
  ideasLabelled: 1,
  sheetPlace: 0.9,
  /** The average cost of an open question (navigator, answer, check) on an own key. */
  openCostUsd: 0.025
} as const

/** The live run stops once its reported cost passes this. */
const LIVE_STOP_USD = 1

/** The kinds the open-question cost covers: navigated answer turns (design Part 5's open row). */
const OPEN_KINDS: readonly QuestionKind[] = ['open', 'ordinal', 'absence', 'idea', 'notFound']
/** The kinds answer correctness covers: a labelled passage the answer must cite. */
const CORRECTNESS_KINDS: readonly QuestionKind[] = ['lookupStale', 'open', 'ordinal', 'idea']
const INSTANT_KINDS: readonly QuestionKind[] = ['slot', 'knows', 'whoKnows']

/** The renderer's scoped absence words: never in a request (P2b rule 9, P3 rule 5). */
const SCOPED = /no (?:other )?scene shows|checked up to/iu
/** Someone not knowing as a line the app made: never in a user turn sent. */
const DOES_NOT_KNOW = /\b(?:does(?:n['’]t| not) know|never learns?)\b/iu

// ---- One request as the run saw it -----------------------------------------------------------

/** A request and its reply, kept in memory for scoring (never written to a report). */
export interface Captured {
  kind: ScribeRequestKind
  messages: AiMessage[]
  text: string
  finishReason: string | null
}

async function* recordStream(
  chunks: AsyncIterable<StreamChunk>,
  messages: AiMessage[],
  sink: Captured[]
): AsyncGenerator<StreamChunk> {
  let text = ''
  let finishReason: string | null = null
  for await (const chunk of chunks) {
    text += chunk.delta
    if (chunk.finishReason !== undefined) finishReason = chunk.finishReason
    yield chunk
  }
  sink.push({ kind: scribeRequestKind(messages), messages, text, finishReason })
}

/** The provider with every request and reply kept in `sink` (for the citation and cite scores). */
export function recordingProvider(provider: Provider, sink: Captured[]): Provider {
  return {
    id: provider.id,
    resolveModel: (tier) => provider.resolveModel(tier),
    complete: async (request) => {
      const result = await provider.complete(request)
      sink.push({
        kind: scribeRequestKind(request.messages),
        messages: request.messages,
        text: result.text,
        finishReason: result.finishReason ?? null
      })
      return result
    },
    stream: (request) => recordStream(provider.stream(request), request.messages, sink),
    testConnection: () => provider.testConnection(),
    ...(provider.price === undefined ? {} : { price: provider.price })
  }
}

// ---- The book and the questions ------------------------------------------------------------

/** A test book ready for Ms Scribe, and how the questions reach the provider. */
export interface ScribeSession {
  book: TestBookProject
  run: LiveRequestDeps
  captured: Captured[]
  reader: NavigateReader
  /** The provider error that stopped a live reading of the memory, or null. */
  readError: string | null
  close(): void
}

/**
 * The test book as Ms Scribe meets it: read (by the oracle, free, or by the live reader and
 * checker through `run`), its labelled pages written, the author's late edits made and checked by
 * the anchors job, every scene and record indexed for the search, and Use AI on.
 */
export async function openScribeSession(
  live: Pick<LiveProvider, 'provider' | 'local'>,
  options: { read: 'oracle' | 'live'; now: Date; stopUsd?: number }
): Promise<ScribeSession> {
  const captured: Captured[] = []
  const run = liveRequestDeps({
    provider: recordingProvider(live.provider, captured),
    local: live.local
  })
  const stopUsd = options.stopUsd ?? Infinity
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scribe-eval-'))
  const book = buildTestBookProject(tmp, options.now)
  const close = (): void => {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  try {
    const memory =
      options.read === 'live'
        ? run.deps
        : fakeAi(
            (request) =>
              requestKind(request) === 'verify'
                ? { text: oracleVerify(request) }
                : { text: oracleRead(request) },
            { now: options.now }
          ).deps
    // A live reading stops with the run's cost stop (the questions after it are skipped).
    const outcomes = await readBook(book, memory, {
      providerErrors: 'stop',
      stopAt: () => run.spent() > stopUsd || run.costUnknown() !== null
    })
    addTestBookPages(book, options.now)
    for (const question of SCRIBE_QUESTIONS) {
      if (question.edit === undefined) continue
      editTestBook(book, question.edit)
      runAnchors(book.db, book.scenes.get(question.edit.scene) ?? '', options.now)
    }
    for (const node of new Set(book.scenes.values())) indexScene(book.db, node, options.now)
    for (const record of listRecords(book.db)) indexOwner(book.db, 'record', record.id, options.now)
    setAiSettings(book.db, { ...defaultAiSettings(), dial: 1 })
    const reader: NavigateReader = {
      readNow: async (nodeId, requestId) => {
        const outcome = await runReading(
          book.db,
          { ai: run.deps },
          {
            nodeId,
            caretPara: null,
            requestId
          }
        )
        if (outcome.read) {
          return {
            ok: true,
            read: true,
            reason: null,
            readingId: outcome.readingId,
            costUsd: outcome.costUsd
          }
        }
        return {
          ok: true,
          read: false,
          reason: outcome.reason === 'localCutoff' ? 'paused' : outcome.reason,
          readingId: null,
          costUsd: 0
        }
      },
      checkAnchors: (nodeId) => void runAnchors(book.db, nodeId, options.now)
    }
    return { book, run, captured, reader, readError: readingStop(outcomes), close }
  } catch (err) {
    close()
    throw err
  }
}

/** What one question got. */
export type AskOutcome =
  | { kind: 'instant'; card: InstantCard }
  | { kind: 'route'; decision: RouteDecision }
  | { kind: 'answer'; navigation: Navigation | null; result: ScribeResult }
  | { kind: 'error'; error: string }
  | { kind: 'skipped' }

export interface ScribeAsk {
  question: LabelQuestion
  outcome: AskOutcome
  /** The ledger rows its requests wrote (none for an instant card). */
  rows: UsageEntry[]
  captured: Captured[]
}

/**
 * One question as the chat asks it (the renderer's path, P3 §4.3): `ai:navigate`'s logic, then
 * for an answer turn `ai:agent`'s (`runScribe`) with the navigation, in Ask (write) or, where the
 * label says so, Plan (read). A provider error (a 429, a 402, a 5xx) is the question's outcome.
 */
export async function askScribe(
  session: ScribeSession,
  question: LabelQuestion,
  now: Date
): Promise<ScribeAsk> {
  const { book, run } = session
  const rows = run.ledger.length
  const seen = session.captured.length
  const nodeId = book.scenes.get(question.asOf) ?? null
  const requestId = `scribe-${question.id}`
  const focus = { beforeCaret: '', selection: '' }
  let outcome: AskOutcome
  try {
    const navigated = await runNavigate(
      book.db,
      run.deps,
      session.reader,
      { nodeId, message: question.question, history: [], focus, requestId },
      () => undefined
    )
    if (navigated.kind === 'instant') outcome = { kind: 'instant', card: navigated.card }
    else if (navigated.kind === 'route') outcome = { kind: 'route', decision: navigated.decision }
    else {
      const result = await runScribe(
        book.db,
        run.deps,
        {
          nodeId,
          message: question.question,
          history: [],
          access: question.plan === true ? 'read' : 'write',
          focus,
          requestId,
          navigation: navigated.navigation
        },
        () => undefined,
        {},
        () => now
      )
      outcome = { kind: 'answer', navigation: navigated.navigation, result }
    }
  } catch (err) {
    const said = liveProviderError(err)
    if (said === null) throw err
    outcome = { kind: 'error', error: said }
  }
  return {
    question,
    outcome,
    rows: run.ledger.slice(rows),
    captured: session.captured.slice(seen)
  }
}

// ---- Scoring -------------------------------------------------------------------------------

const normal = (text: string): string =>
  text.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ').trim().toLowerCase()
const holds = (text: string, quote: string): boolean => normal(text).includes(normal(quote))

/** Whether a scope line covers every scene up to now (or the whole book). */
const coversAll = (scope: string | null, now: string): boolean =>
  scope !== null && (scope.includes(`every scene up to ${now}`) || scope.includes('the whole book'))

/** The answer text of an `agent.v9` reply, or null for a need or an unreadable one. */
function replyAnswer(text: string): string | null {
  const json = replyObject(text)
  return typeof json?.answer === 'string' ? json.answer : null
}

/** The ledger's feature as a cost part of the turn (P3-D23). */
const partOf = (feature: string): 'navigator' | 'answer' | 'cite' | 'reader' =>
  feature === 'navigator'
    ? 'navigator'
    : feature === 'cite'
      ? 'cite'
      : feature === 'agent'
        ? 'answer'
        : 'reader'

/** How one question did (the replays assert it right; the live run holds it to the bars). */
export interface ScribeQuestionScore {
  id: string
  kind: QuestionKind
  outcome: 'instant' | 'route' | 'lookup' | 'answer' | 'error' | 'skipped'
  /** Right by its kind's measure; null when it was not asked (the stop). */
  right: boolean | null
  /** Why it is not right, in words. */
  why: string[]
  routed: boolean | null
  instant: boolean | null
  correct: boolean | null
  /** Citations the answer replies made, and how many pass the code check (sent id, quote held). */
  citations: { made: number; kept: number }
  /** `cite.v1`'s verdicts (and scope), and how many the labels' checker gives too. */
  cite: { checked: number; agree: number }
  scope: boolean | null
  notFound: boolean | null
  absenceAsFact: boolean
  idea: boolean | null
  place: boolean | null
  widened: boolean
  misses: number
  /** `agent.v9` replies, and how many were cut off at their cap. */
  answers: number
  cutOff: number
  /** Reasoning tokens spent on an answer, lookup, idea or to-do turn (expected 0, P3-D11). */
  reasoningTokens: number
  costUsd: number
  parts: Record<'navigator' | 'answer' | 'cite' | 'reader', number>
  requests: number
  error: string | null
}

/** Scores one question against its label. */
export function scoreAsk(book: TestBookProject, ask: ScribeAsk): ScribeQuestionScore {
  const { question, outcome } = ask
  const { expected } = question
  const now = sceneRef(question.asOf)
  const parts = { navigator: 0, answer: 0, cite: 0, reader: 0 }
  for (const row of ask.rows) parts[partOf(row.feature)] += row.costUsd
  const answers = ask.captured.filter((each) => each.kind === 'answer')
  const score: ScribeQuestionScore = {
    id: question.id,
    kind: question.kind,
    outcome: 'skipped',
    right: null,
    why: [],
    routed: null,
    instant: null,
    correct: null,
    citations: { made: 0, kept: 0 },
    cite: { checked: 0, agree: 0 },
    scope: null,
    notFound: null,
    absenceAsFact: false,
    idea: null,
    place: null,
    widened: false,
    misses: 0,
    answers: answers.length,
    cutOff: answers.filter((each) => each.finishReason === 'length').length,
    reasoningTokens: 0,
    costUsd: ask.rows.reduce((sum, row) => sum + row.costUsd, 0),
    parts,
    requests: ask.rows.length,
    error: null
  }
  const why = (ok: boolean, said: string): boolean => {
    if (!ok) score.why.push(said)
    return ok
  }
  if (outcome.kind === 'skipped') return score
  if (outcome.kind === 'error') {
    return { ...score, outcome: 'error', right: false, error: outcome.error, why: [outcome.error] }
  }
  // cite.v1 against the labels' checker, verdict by verdict ("partly" keeps a citation: a yes).
  for (const each of ask.captured.filter((request) => request.kind === 'cite')) {
    const oracle = oracleCiteReply(each.messages)
    const got = parseCiteReply(each.text)
    for (const verdict of oracle.v) {
      const said = got.verdicts.get(verdict.i)
      score.cite.checked += 1
      if ((said === 'no' ? 'no' : 'yes') === verdict.ok) score.cite.agree += 1
    }
    if (oracle.scope !== 'none') {
      score.cite.checked += 1
      if ((got.scope ?? 'ok') === oracle.scope) score.cite.agree += 1
    }
  }
  if (outcome.kind === 'instant') {
    score.outcome = 'instant'
    const card = outcome.card
    const wanted = expected.scene === undefined ? '' : sceneRef(expected.scene)
    let ok = INSTANT_KINDS.includes(question.kind)
    if (card.kind === 'slot' || card.kind === 'knows') {
      ok &&= card.kind === 'knows' ? question.kind === 'knows' : question.kind === 'slot'
      ok &&= card.ref === wanted && holds(card.quote ?? '', expected.quoteHas ?? '')
    } else if (card.kind === 'whoKnows') {
      ok &&= question.kind === 'whoKnows' && card.readersSince?.ref === wanted
      ok &&= card.holders.some((holder) => {
        const said = holder.claimId === null ? null : getClaim(book.db, holder.claimId)
        return said !== null && holds(said.quote, expected.quoteHas ?? '')
      })
    } else {
      ok &&= question.kind === 'slot'
    }
    score.instant = why(ok, `instant card ${card.kind} not the label's`)
    score.right = INSTANT_KINDS.includes(question.kind)
      ? score.instant
      : why(false, 'answered by an instant card')
    return score
  }
  if (outcome.kind === 'route') {
    score.outcome = 'route'
    const { decision } = outcome
    const ok =
      decision.action === expected.action &&
      (expected.pass === undefined || decision.edit?.pass === expected.pass) &&
      (expected.target === undefined || decision.edit?.target === expected.target) &&
      (expected.chapter === undefined || decision.edit?.chapter === expected.chapter)
    score.routed =
      question.kind === 'route'
        ? why(
            ok,
            `routed ${decision.action} ${decision.edit?.pass ?? ''} ${decision.edit?.target ?? ''}`.trim()
          )
        : null
    score.right =
      question.kind === 'route' ? score.routed : why(false, `routed to ${decision.action}`)
    return score
  }
  const { result, navigation } = outcome
  const navigated = ask.rows.some((row) => row.feature === 'navigator')
  score.outcome = !navigated && navigation?.turn === 'lookup' ? 'lookup' : 'answer'
  const turn = result.scribe.turn
  if (turn === 'answer' || turn === 'lookup' || turn === 'idea' || turn === 'todo') {
    score.reasoningTokens = ask.rows
      .filter((row) => row.feature === 'agent')
      .reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0)
  }
  score.widened = result.scribe.widened !== null
  score.misses = result.scribe.misses
  // Citation validity: every citation each answer reply made, and how many name an item that was
  // sent and quote words that item holds, as the code check reads them (`quoteHeld`); a map
  // (a card) never counts. Measured on the replies, before cite.v1 or a retry acts on them.
  for (const each of answers) {
    const said = replyAnswer(each.text)
    if (said === null) continue
    const items = new Map(
      answerEvidence(answerTail(each.messages)).map((item) => [item.id, item] as const)
    )
    const made = new Map(
      parseCitedAnswer(said)
        .sentences.flatMap((sentence) => sentence.citations)
        .map((citation) => [`${citation.evidence}\u0000${citation.quote}`, citation] as const)
    )
    for (const citation of made.values()) {
      const item = items.get(citation.evidence)
      score.citations.made += 1
      if (
        item !== undefined &&
        !item.tag.startsWith('map') &&
        quoteHeld(item.lines, citation.quote)
      ) {
        score.citations.kept += 1
      }
    }
  }
  const answer = result.answer
  score.absenceAsFact = statesAbsenceAsFact(answer) && !statesScope(answer)
  if (score.absenceAsFact) score.why.push('states an absence as fact')
  const cites = result.scribe.citations
  const cited = (where: (citation: (typeof cites)[number]) => boolean): boolean =>
    cites.some((citation) => where(citation) && holds(citation.quote, expected.quoteHas ?? ''))
  switch (question.kind) {
    case 'lookupStale':
    case 'open':
    case 'ordinal':
    case 'idea': {
      const ok =
        expected.label !== undefined
          ? cited((citation) => citation.label === expected.label)
          : cited(
              (citation) =>
                citation.open?.kind === 'scene' &&
                sceneOf(book, citation.open.id) === expected.scene
            )
      score.correct = why(
        ok,
        `does not cite the label's passage (${cites.map((c) => c.ref).join(', ') || 'no citation'})`
      )
      break
    }
    default:
      break
  }
  if (question.kind === 'lookupStale' && score.outcome !== 'lookup') why(false, 'not a lookup turn')
  if (question.kind === 'ordinal' || question.kind === 'absence') {
    score.scope = why(
      statesScope(answer) && coversAll(result.scribe.scope, now),
      `scope not every scene up to ${now} (${result.scribe.scope ?? 'none'})`
    )
  }
  if (question.kind === 'notFound') {
    score.notFound = why(result.scribe.notFound, 'did not end not found')
  }
  if (question.kind === 'idea') {
    score.idea = why(
      cites.some((citation) => citation.label === 'idea'),
      'no source labelled your idea'
    )
  }
  if (question.kind === 'pin') {
    const line = result.changes.find((change) => change.edit.kind === 'sheetLine')?.edit
    const place = line?.kind === 'sheetLine' ? (line.place ?? 'ask') : undefined
    const record = line?.kind === 'sheetLine' ? line.recordId : undefined
    score.place = why(
      place === expected.place &&
        (place === undefined || record === book.records.get(question.record ?? '')),
      `sheet line ${place ?? 'none'} (expected ${expected.place ?? 'none'})`
    )
  }
  const measures: Record<QuestionKind, () => (boolean | null)[]> = {
    slot: () => [why(false, 'not an instant card')],
    knows: () => [why(false, 'not an instant card')],
    whoKnows: () => [why(false, 'not an instant card')],
    lookupStale: () => [score.correct, score.outcome === 'lookup'],
    open: () => [score.correct],
    ordinal: () => [score.correct, score.scope],
    absence: () => [score.scope],
    idea: () => [score.correct, score.idea],
    notFound: () => [score.notFound],
    route: () => [why(false, 'not routed')],
    pin: () => [score.place]
  }
  score.right = measures[question.kind]().every((each) => each === true) && !score.absenceAsFact
  return score
}

/** A share: part of whole, or n/a. */
interface Share {
  right: number
  of: number
}

const share = (
  scores: readonly ScribeQuestionScore[],
  pick: (s: ScribeQuestionScore) => boolean | null
): Share => {
  const measured = scores.map(pick).filter((each): each is boolean => each !== null)
  return { right: measured.filter(Boolean).length, of: measured.length }
}

/** The whole run's measures (plan P3 §6.3). */
export interface ScribeRunScore {
  questions: ScribeQuestionScore[]
  routing: Share
  instant: Share
  correctness: Share
  citations: { kept: number; made: number }
  cite: { agree: number; checked: number }
  scope: Share
  notFound: Share
  /** Questions whose answer states an absence as fact. */
  absenceAsFact: string[]
  ideas: Share
  place: Share
  widened: number
  misses: number
  cutOff: { cut: number; answers: number }
  reasoningTokens: number
  /** Questions asked and their average cost, by kind. */
  costByKind: Partial<Record<QuestionKind, { questions: number; averageUsd: number }>>
  /** The average open question (navigated answers), or null with none asked. */
  openCostUsd: number | null
}

export function scoreScribeRun(book: TestBookProject, asks: readonly ScribeAsk[]): ScribeRunScore {
  const questions = asks.map((ask) => scoreAsk(book, ask))
  const asked = questions.filter((each) => each.outcome !== 'skipped')
  const of = (kinds: readonly QuestionKind[]): ScribeQuestionScore[] =>
    asked.filter((each) => kinds.includes(each.kind))
  const costByKind: ScribeRunScore['costByKind'] = {}
  for (const kind of QUESTION_KINDS) {
    const these = of([kind])
    if (these.length === 0) continue
    costByKind[kind] = {
      questions: these.length,
      averageUsd: these.reduce((sum, each) => sum + each.costUsd, 0) / these.length
    }
  }
  const open = of(OPEN_KINDS)
  return {
    questions,
    routing: share(of(['route']), (each) => each.right),
    instant: share(of(INSTANT_KINDS), (each) => each.instant ?? false),
    correctness: share(of(CORRECTNESS_KINDS), (each) => each.correct ?? false),
    citations: {
      kept: asked.reduce((sum, each) => sum + each.citations.kept, 0),
      made: asked.reduce((sum, each) => sum + each.citations.made, 0)
    },
    cite: {
      agree: asked.reduce((sum, each) => sum + each.cite.agree, 0),
      checked: asked.reduce((sum, each) => sum + each.cite.checked, 0)
    },
    scope: share(of(['ordinal', 'absence']), (each) => each.scope ?? false),
    notFound: share(of(['notFound']), (each) => each.notFound ?? false),
    absenceAsFact: asked.filter((each) => each.absenceAsFact).map((each) => each.id),
    ideas: share(of(['idea']), (each) => each.idea ?? false),
    place: share(of(['pin']), (each) => each.place ?? false),
    widened: asked.filter((each) => each.widened).length,
    misses: asked.reduce((sum, each) => sum + each.misses, 0),
    cutOff: {
      cut: asked.reduce((sum, each) => sum + each.cutOff, 0),
      answers: asked.reduce((sum, each) => sum + each.answers, 0)
    },
    reasoningTokens: asked.reduce((sum, each) => sum + each.reasoningTokens, 0),
    costByKind,
    openCostUsd:
      open.length === 0 ? null : open.reduce((sum, each) => sum + each.costUsd, 0) / open.length
  }
}

// ---- The live run and its report -----------------------------------------------------------

export interface ScribeLiveRun {
  models: Record<Tier, string>
  route: string
  stopUsd: number
  read: 'oracle' | 'live'
  costUsd: number
  requests: number
  /** The cost stop came before the last question. */
  stopped: boolean
  /** The provider error that stopped the run (where), or null. */
  error: string | null
  costUnknown: string | null
  at?: Date
}

export interface ScribeLiveReport {
  markdown: string
  json: unknown
  failures: string[]
  score: ScribeRunScore
  run: ScribeLiveRun
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${part}/${whole} (${((part / whole) * 100).toFixed(1)} %)`
const cents = (usd: number | null): string => (usd === null ? 'n/a' : `${(usd * 100).toFixed(2)}¢`)

/** The run's report: the measures against the bars (P3-D20), then each question. */
export function scribeReport(score: ScribeRunScore, run: ScribeLiveRun): ScribeLiveReport {
  const bars = SCRIBE_PASS_BARS
  const failures: string[] = []
  const bar = (name: string, value: Share, min: number): void => {
    if (value.of > 0 && value.right / value.of < min) {
      failures.push(`${name} ${percent(value.right, value.of)} < ${min * 100} %`)
    }
  }
  bar('routing', score.routing, bars.routing)
  bar('answer correctness', score.correctness, bars.correctness)
  bar(
    'citation validity',
    { right: score.citations.kept, of: score.citations.made },
    bars.citationValidity
  )
  bar('scope honesty', score.scope, bars.scopeHonesty)
  bar('not-found honesty', score.notFound, bars.notFoundHonesty)
  bar('Ideas labelled', score.ideas, bars.ideasLabelled)
  bar('sheet-write place', score.place, bars.sheetPlace)
  if (score.absenceAsFact.length > bars.absenceAsFact) {
    failures.push(`absence as fact in ${score.absenceAsFact.join(', ')}`)
  }
  if (score.openCostUsd !== null && score.openCostUsd > bars.openCostUsd) {
    failures.push(`open question ${cents(score.openCostUsd)} > ${cents(bars.openCostUsd)}`)
  }
  if (run.stopped) failures.push(`stopped at the ${run.stopUsd} USD cap before the last question`)
  if (run.error !== null) failures.push(`stopped by a provider error (${run.error})`)
  if (run.costUnknown !== null) failures.push(run.costUnknown)
  const kinds = Object.entries(score.costByKind).map(
    ([kind, each]) => `${kind} ${cents(each.averageUsd)} (${each.questions})`
  )
  const lines = [
    `# Story memory: the live Ms Scribe run (${(run.at ?? new Date()).toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`, on ${run.route}. ` +
      `Memory read by ${run.read === 'live' ? 'the live reader and checker' : 'the oracle'}. ` +
      `Requests: ${run.requests}; reported cost: ${run.costUsd.toFixed(4)} USD (it stops at ${run.stopUsd} USD).`,
    '',
    '## Pass bars (decided by Claude, unconfirmed; P3-D20)',
    '',
    '| Measure | Result | Bar |',
    '| --- | --- | --- |',
    `| Routing (action, pass, target) | ${percent(score.routing.right, score.routing.of)} | ≥ ${bars.routing * 100} % |`,
    `| Instant rate (slot, knows, who-knows with no request) | ${percent(score.instant.right, score.instant.of)} | no bar |`,
    `| Answer correctness (the label's scene and words cited) | ${percent(score.correctness.right, score.correctness.of)} | ≥ ${bars.correctness * 100} % |`,
    `| Citation validity (made citations the code check keeps: a sent item, its words) | ${percent(score.citations.kept, score.citations.made)} | ≥ ${bars.citationValidity * 100} % |`,
    `| cite.v1 agreement with the labels | ${percent(score.cite.agree, score.cite.checked)} | no bar |`,
    `| Scope honesty (ordinal and absence answers search every earlier scene) | ${percent(score.scope.right, score.scope.of)} | ${bars.scopeHonesty * 100} % |`,
    `| Not-found honesty | ${percent(score.notFound.right, score.notFound.of)} | ${bars.notFoundHonesty * 100} % |`,
    `| Absence stated as fact | ${score.absenceAsFact.length} | ${bars.absenceAsFact} |`,
    `| Ideas labelled "your idea" | ${percent(score.ideas.right, score.ideas.of)} | ${bars.ideasLabelled * 100} % |`,
    `| Sheet-write place (pinned, ideas, ask; none in Plan) | ${percent(score.place.right, score.place.of)} | ≥ ${bars.sheetPlace * 100} % |`,
    `| Widened (Self-Route) / search misses logged | ${score.widened} / ${score.misses} | no bar |`,
    `| Answers cut off at their cap | ${percent(score.cutOff.cut, score.cutOff.answers)} | no bar |`,
    `| Reasoning tokens on answer turns | ${score.reasoningTokens} | 0 expected |`,
    `| Average open question (own key; design ≈ 2¢) | ${cents(score.openCostUsd)} | ≤ ${cents(bars.openCostUsd)} |`,
    `| Cost by kind (average) | ${kinds.join('; ') || 'none'} | lookup ≈ 1¢, open ≈ 2¢ |`,
    '',
    failures.length === 0 ? '**Passed.**' : `**Failed:** ${failures.join('; ')}.`,
    '',
    '## Questions',
    '',
    '| Question | Kind | Outcome | Right | Cost | Why not |',
    '| --- | --- | --- | --- | --- | --- |',
    ...score.questions.map(
      (each) =>
        `| ${each.id} | ${each.kind} | ${each.outcome} | ${each.right === null ? '—' : each.right ? 'yes' : 'no'} | ${cents(each.costUsd)} | ${each.why.join('; ').replace(/\|/gu, '/')} |`
    ),
    '',
    'No prompt text and no key are written here.'
  ]
  return {
    markdown: lines.join('\n'),
    json: { ...run, bars, score, failures },
    failures,
    score,
    run
  }
}

/**
 * The live Ms Scribe run (plan P3 §6.3): one pass over the test book with the real
 * `navigator.v1`, `agent.v9` and `cite.v1` through `live`, the memory read by the oracle (free) or,
 * with `read: 'live'`, by the real reader and checker first. It stops once the reported cost passes
 * `stopUsd`, once a cost cannot be known, or at a provider error; the report is written either
 * way, with what was asked and what it cost.
 */
export async function runLiveScribe(
  live: LiveProvider,
  options: { stopUsd?: number; now?: Date; read?: 'oracle' | 'live' } = {}
): Promise<ScribeLiveReport> {
  const stopUsd = options.stopUsd ?? LIVE_STOP_USD
  const now = options.now ?? new Date()
  const read = options.read ?? 'oracle'
  const session = await openScribeSession(live, { read, now, stopUsd })
  const over = (): boolean => session.run.spent() > stopUsd
  try {
    const asks: ScribeAsk[] = []
    let error = session.readError
    let stopped = false
    for (const question of SCRIBE_QUESTIONS) {
      if (error !== null || session.run.costUnknown() !== null || stopped || over()) {
        stopped ||= over()
        asks.push({ question, outcome: { kind: 'skipped' }, rows: [], captured: [] })
        continue
      }
      const ask = await askScribe(session, question, now)
      if (ask.outcome.kind === 'error') error = `${question.id}: ${ask.outcome.error}`
      asks.push(ask)
    }
    return scribeReport(scoreScribeRun(session.book, asks), {
      models: live.models,
      route: live.describe,
      stopUsd,
      read,
      costUsd: session.run.spent(),
      requests: session.run.ledger.length,
      stopped,
      error,
      costUnknown: session.run.costUnknown(),
      at: now
    })
  } finally {
    session.close()
  }
}

// ---- The offline replays -------------------------------------------------------------------

/** The rows of the tables the chat must never write (P3 rule 6). */
const tableCounts = (book: TestBookProject): number[] =>
  [claim, card, reading].map((table) => book.db.select().from(table).all().length)

/** The citations an answer kept, as the invariants read them (a card would be `citesCard`). */
const citationsOf = (asks: readonly ScribeAsk[]): InvariantCitation[] =>
  asks.flatMap((ask) =>
    ask.outcome.kind === 'answer'
      ? ask.outcome.result.scribe.citations.map((citation) => ({
          answerId: ask.question.id,
          target: citation.label === 'map' ? ('card' as const) : ('passage' as const),
          ref: citation.ref
        }))
      : []
  )

const byId = (asks: readonly ScribeAsk[], id: string): ScribeAsk =>
  asks.find((ask) => ask.question.id === id) ?? fail()

const answerOf = (ask: ScribeAsk): ScribeResult =>
  ask.outcome.kind === 'answer' ? ask.outcome.result : fail()

/** The server and live provider every replay talks to (`OPENROUTER_API_KEY` alone). */
function oracleLive(
  plants?: ScribePlants,
  costUsd?: number
): { server: ChatServer; live: LiveProvider } {
  const server = scribeOracleServer({
    ...(plants === undefined ? {} : { plants }),
    ...(costUsd === undefined ? {} : { costUsd })
  })
  return {
    server,
    live: liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
  }
}

describe('Ms Scribe over the test book: the oracle replay (F-16.24, F-16.25, F-16.26)', () => {
  let session: ScribeSession | undefined
  let server: ChatServer | undefined
  let asks: ScribeAsk[] = []
  let before: number[] = []
  let after: number[] = []

  beforeAll(async () => {
    const oracle = oracleLive()
    server = oracle.server
    session = await openScribeSession(oracle.live, { read: 'oracle', now: NOW })
    before = tableCounts(session.book)
    asks = []
    for (const question of SCRIBE_QUESTIONS) asks.push(await askScribe(session, question, NOW))
    after = tableCounts(session.book)
  }, 120_000)
  afterAll(() => session?.close())

  const of = (...kinds: QuestionKind[]): ScribeAsk[] =>
    asks.filter((ask) => kinds.includes(ask.question.kind))

  it('answers every slot, knows and who-knows question with an instant card and no request', () => {
    const book = session?.book ?? fail()
    const instant = of('slot', 'knows', 'whoKnows')
    expect(instant.length).toBeGreaterThanOrEqual(5)
    for (const ask of instant) {
      expect(ask.outcome.kind, ask.question.id).toBe('instant')
      expect(ask.rows, ask.question.id).toEqual([])
      expect(ask.captured, ask.question.id).toEqual([])
      expect(scoreAsk(book, ask), ask.question.id).toMatchObject({ instant: true, right: true })
    }
  })

  it('hands a stale or contested value to Ms Scribe as a lookup turn, with no navigator request', () => {
    const book = session?.book ?? fail()
    for (const ask of of('lookupStale')) {
      const at = ask.question.id
      expect(ask.outcome.kind, at).toBe('answer')
      expect(ask.outcome.kind === 'answer' ? ask.outcome.navigation?.turn : null, at).toBe('lookup')
      expect(
        ask.captured.map((each) => each.kind),
        at
      ).toEqual(['answer', 'cite'])
      expect(scoreAsk(book, ask), at).toMatchObject({
        outcome: 'lookup',
        correct: true,
        right: true
      })
    }
    // The edited age: the paragraph as it reads now, never the stale fact line's value.
    const clara = answerOf(byId(asks, 'lookup-clara-edited'))
    expect(clara.scribe.citations.map((citation) => citation.quote).join(' ')).toContain(
      'eight-and-twenty'
    )
    expect(clara.scribe.citations.map((citation) => citation.quote).join(' ')).not.toContain(
      'seven-and-twenty'
    )
  })

  it('routes as the labels say (F-5.26 kept): one navigator request, nothing else sent', () => {
    const book = session?.book ?? fail()
    const routes = of('route')
    expect(routes.length).toBeGreaterThanOrEqual(4)
    for (const ask of routes) {
      const at = ask.question.id
      expect(
        ask.captured.map((each) => each.kind),
        at
      ).toEqual(['navigator'])
      expect(scoreAsk(book, ask), at).toMatchObject({ outcome: 'route', routed: true, right: true })
    }
    const better = byId(asks, 'route-better').outcome
    expect(better.kind === 'route' ? better.decision : null).toEqual({
      action: 'editPass',
      instruction: null,
      edit: { pass: 'ask', target: 'scene', chapter: null }
    })
  })

  it('answers open, ordinal and idea questions from the labelled passage, quote and sentence checked', () => {
    const book = session?.book ?? fail()
    for (const ask of of('open', 'ordinal', 'idea')) {
      const at = ask.question.id
      const result = answerOf(ask)
      expect(scoreAsk(book, ask), at).toMatchObject({
        outcome: 'answer',
        correct: true,
        right: true
      })
      expect(result.scribe.citations.length, at).toBeGreaterThan(0)
      expect(
        result.scribe.citations.every((citation) => citation.checked === 'cite'),
        at
      ).toBe(true)
      expect(result.scribe.notChecked, at).toEqual([])
      expect(result.scribe.unsupported, at).toEqual([])
      expect(ask.captured.filter((each) => each.kind === 'navigator').length, at).toBeGreaterThan(0)
    }
    for (const ask of of('ordinal')) {
      const result = answerOf(ask)
      expect(result.scribe.scope, ask.question.id).toContain('every scene up to 18.1')
      expect(statesScope(result.answer), ask.question.id).toBe(true)
    }
    for (const ask of of('idea')) {
      const result = answerOf(ask)
      expect(result.scribe.citations.map((citation) => citation.label)).toContain('idea')
      expect(result.answer).toContain('your idea, not in the book')
    }
    const bell = answerOf(byId(asks, 'open-bell-pinned'))
    expect(bell.scribe.citations.map((citation) => citation.label)).toEqual(['notes'])
  })

  it('ends a not-found question not found with what it looked in, and states no absence', () => {
    const book = session?.book ?? fail()
    for (const ask of of('notFound')) {
      const result = answerOf(ask)
      expect(result.scribe.notFound, ask.question.id).toBe(true)
      expect(result.answer, ask.question.id).toMatch(/^Not found in the manuscript \(I looked in /u)
    }
    for (const ask of of('absence')) {
      const at = ask.question.id
      const result = answerOf(ask)
      expect(scoreAsk(book, ask), at).toMatchObject({
        scope: true,
        absenceAsFact: false,
        right: true
      })
      expect(result.answer, at).toMatch(/^I found no scene where /u)
      expect(result.scribe.scope, at).toContain('every scene up to 18.1')
    }
    // Nothing sent says someone does not know: not the renderer's scoped words, not a line.
    for (const each of session?.captured ?? []) {
      expect(JSON.stringify(each.messages)).not.toMatch(SCOPED)
      for (const message of each.messages.filter((m) => m.role === 'user')) {
        expect(message.content).not.toMatch(DOES_NOT_KNOW)
      }
    }
    expect(server?.calls.length).toBe(session?.captured.length)
  })

  it('puts a sheet line where the author asked, asks “idea or canon?” when unsure, and Plan writes nothing', () => {
    const book = session?.book ?? fail()
    for (const ask of of('pin')) {
      expect(scoreAsk(book, ask), ask.question.id).toMatchObject({ place: true, right: true })
    }
    const plan = answerOf(byId(asks, 'pin-plan'))
    expect(plan.changes).toEqual([])
    expect(plan.answer).toContain('Ask or Auto')
    const asked = answerOf(byId(asks, 'pin-lottie-scar')).changes.map((change) => change.edit)
    expect(asked).toEqual([
      expect.objectContaining({ kind: 'sheetLine', place: null, text: 'A scar from the fire.' })
    ])
  })

  it('sends each prompt as the app does: fast and reasoning off for the navigator and the check', () => {
    const calls = server?.calls ?? fail()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      const kind = scribeRequestKind(call.messages)
      if (kind === 'navigator' || kind === 'cite') {
        expect(call.body).toMatchObject({
          model: OPENROUTER_DEFAULT_MODELS.fast,
          reasoning: { enabled: false }
        })
      }
      if (kind === 'answer') {
        expect(call.body).toMatchObject({ model: OPENROUTER_DEFAULT_MODELS.strong, stream: true })
      }
    }
    // Answer, lookup and idea turns go out with reasoning off (P3-D11); sheet requests are edits.
    const answerTurns = asks.filter(
      (ask) => ask.outcome.kind === 'answer' && ask.outcome.result.scribe.turn !== 'edit'
    )
    for (const ask of answerTurns) {
      for (const each of ask.captured.filter((request) => request.kind === 'answer')) {
        const call = calls.find(
          (c) =>
            c.messages === each.messages ||
            JSON.stringify(c.messages) === JSON.stringify(each.messages)
        )
        expect(call?.body.reasoning, ask.question.id).toEqual({ enabled: false })
      }
    }
  })

  it('meets every pass bar against the oracle', () => {
    const book = session?.book ?? fail()
    const score = scoreScribeRun(book, asks)
    const report = scribeReport(score, {
      models: OPENROUTER_DEFAULT_MODELS,
      route: 'OpenRouter (test)',
      stopUsd: LIVE_STOP_USD,
      read: 'oracle',
      costUsd: 0,
      requests: 0,
      stopped: false,
      error: null,
      costUnknown: null
    })
    expect(report.failures).toEqual([])
    expect(
      score.questions.filter((each) => each.right !== true).map((each) => [each.id, each.why])
    ).toEqual([])
    expect(score.instant).toEqual({
      right: of('slot', 'knows', 'whoKnows').length,
      of: of('slot', 'knows', 'whoKnows').length
    })
    expect(score.reasoningTokens).toBe(0)
    expect(score.cite.agree).toBe(score.cite.checked)
    expect(score.citations.kept).toBe(score.citations.made)
  })

  it('keeps the invariants, and the chat writes no claim, card or reading', () => {
    const book = session?.book ?? fail()
    expect(after).toEqual(before)
    // Its only write is the search-miss log (P3-D15): one row per miss a widened answer counted.
    const misses = asks.reduce(
      (sum, ask) => sum + (ask.outcome.kind === 'answer' ? ask.outcome.result.scribe.misses : 0),
      0
    )
    expect(searchMisses(book.db, 50).count).toBe(misses)
    expect(invariants(book, citationsOf(asks))).toEqual([])
    expect(session?.captured.some((each) => each.kind === 'reader' || each.kind === 'verify')).toBe(
      false
    )
  })
})

describe('the scribe oracle reads each request as it was sent (F-16.25)', () => {
  it('knows the prompts by their opening sentences', () => {
    const asked = (content: string): AiMessage[] => [{ role: 'system', content }]
    expect(scribeRequestKind(asked(`${NAVIGATOR_SENTINEL} …`))).toBe('navigator')
    expect(scribeRequestKind(asked(`${AGENT_V9_SENTINEL}\n…`))).toBe('answer')
    expect(scribeRequestKind(asked('You are a poet.'))).toBe('other')
  })

  it('finds a scene reference only as a whole token', () => {
    expect(namesRef('happened, 13.1 ¶1', '13.1')).toBe(true)
    expect(namesRef('happened 13.1 ¶3', '13.1')).toBe(true)
    expect(namesRef('happened, the open scene 13.1', '13.1')).toBe(true)
    expect(namesRef('happened, 113.1 ¶1', '13.1')).toBe(false)
    expect(namesRef('happened, 13.10 ¶1', '13.1')).toBe(false)
  })

  it('quotes the sentence that holds the words, past “Mr.”, or a window of a long one', () => {
    expect(
      quoteAround(
        'She did not tell her mother. She wrote to Mr. Ashby at once.',
        'wrote to Mr. Ashby'
      )
    ).toBe('She wrote to Mr. Ashby at once.')
    const long = `${'word '.repeat(30)}the words we want here ${'more '.repeat(10)}`.trim()
    const quote = quoteAround(long, 'the words we want')
    expect(quote).toContain('the words we want')
    expect(quote?.split(' ').length).toBe(18)
    expect(quoteAround('Nothing like it.', 'absent words')).toBeNull()
    expect(citeMarker('E3', 'He said "go".')).toBe('[E3 "He said \\"go\\"."]')
  })
})

// ---- The adversarial replay ----------------------------------------------------------------

/** The prose a planted navigator writes instead of a step: it must reach no later request. */
const NAVIGATOR_PROSE =
  'The duel is first mentioned in 12.1, where the town talks of it in Elsdale.'
/** A sentence citing a quote its item does not hold. */
const UNHELD = 'Johanna burned the letter at once'

/** The planted replies (plan P3 §6.2's adversarial list). */
const PLANTS: ScribePlants = {
  // An answer that cites a card (a map) and a quote its item does not hold.
  'open-johanna-wrote': {
    navigator: (messages, honest, step) => {
      if (step === 1) {
        return JSON.stringify({
          a: 'query',
          t: 'answer',
          i: '',
          call: [{ search: ['wrote', 'letter', 'write'] }, { cards: '13.1' }]
        })
      }
      const maps = navigatorMenu(messages)
        .filter((line) => line.head.startsWith('map'))
        .map((line) => line.id)
      const use: unknown = replyObject(honest)?.use
      const ids = Array.isArray(use) ? use.filter((id): id is string => typeof id === 'string') : []
      return JSON.stringify({ use: [...ids, ...maps] })
    },
    answer: (messages, honest) => {
      const items = answerEvidence(answerTail(messages))
      const map = items.find((item) => item.tag.startsWith('map'))
      const scene = items.find((item) => namesRef(item.tag, '13.1'))
      const quote = map?.lines[0]?.split(' ').slice(0, 6).join(' ') ?? 'the card says so here'
      const extra = [
        `The card for 13.1 says the same. ${citeMarker(map?.id ?? 'E99', quote)}`,
        `Johanna burned the letter at once. ${citeMarker(scene?.id ?? 'E1', UNHELD)}`
      ]
      return JSON.stringify({ ...honest, answer: `${honest.answer ?? ''} ${extra.join(' ')}` })
    }
  },
  // A "first" that is not the first: the scope check finds the earlier passage, twice.
  'ordinal-first-told': {
    navigator: (messages, honest, step) =>
      step === 1
        ? honest
        : JSON.stringify({
            use: navigatorMenu(messages)
              .map((line) => line.id)
              .slice(0, 12)
          }),
    answer: (messages) => {
      const tail = answerTail(messages)
      const found = findQuoted(answerEvidence(tail), 'Mr. Dunmore and I are engaged', (item) =>
        namesRef(item.tag, '10.1')
      )
      const searched = searchedPhrase(tail) ?? 'every scene'
      return JSON.stringify({
        answer: `The earliest I found, searching ${searched}, is 10.1. ${citeMarker(found?.item.id ?? 'E1', found?.quote ?? '')}`,
        found: true,
        edits: []
      })
    }
  },
  // A sheet line of a fact from the book that nobody asked for.
  'open-dunmore-father': {
    answer: (_messages, honest) =>
      JSON.stringify({
        ...honest,
        edits: [
          {
            edit: 'pin',
            name: 'Mr. Dunmore',
            text: 'His father was a clergyman in Elsdale.',
            place: 'pinned'
          }
        ]
      })
  },
  // A second need after the widening.
  'open-lise-overheard': {
    answer: () => JSON.stringify({ need: 'chapter 10' })
  },
  // A navigator that writes prose instead of a step.
  'ordinal-duel': {
    navigator: (_messages, honest, step) => (step === 1 ? NAVIGATOR_PROSE : honest)
  },
  // A navigator step with an answer in it beside its call.
  'idea-captain-past': {
    navigator: (_messages, honest, step) => {
      if (step !== 1) return honest
      return JSON.stringify({ ...replyObject(honest), answer: NAVIGATOR_PROSE })
    }
  }
}

describe('Ms Scribe over the test book: the adversarial replay (F-16.25, F-16.26)', () => {
  let session: ScribeSession | undefined
  let asks: ScribeAsk[] = []
  let before: number[] = []
  let after: number[] = []

  beforeAll(async () => {
    const oracle = oracleLive(PLANTS)
    session = await openScribeSession(oracle.live, { read: 'oracle', now: NOW })
    before = tableCounts(session.book)
    asks = []
    for (const id of Object.keys(PLANTS)) {
      const question = SCRIBE_QUESTIONS.find((each) => each.id === id) ?? fail()
      asks.push(await askScribe(session, question, NOW))
    }
    after = tableCounts(session.book)
  }, 120_000)
  afterAll(() => session?.close())

  it('drops a card citation and a quote its item does not hold, and marks that sentence not checked', () => {
    const book = session?.book ?? fail()
    const ask = byId(asks, 'open-johanna-wrote')
    const result = answerOf(ask)
    // The card was sent (a map, not citable) and cited; the code dropped it.
    const sent = ask.captured.find((each) => each.kind === 'answer') ?? fail()
    expect(
      answerEvidence(answerTail(sent.messages)).some((item) => item.tag.startsWith('map'))
    ).toBe(true)
    expect(replyAnswer(sent.text)).toMatch(/The card for 13\.1 says the same\. \[E\d+ "/u)
    expect(result.scribe.citations.some((citation) => citation.label === 'map')).toBe(false)
    expect(result.scribe.citations.some((citation) => citation.quote.includes(UNHELD))).toBe(false)
    const spans = result.scribe.notChecked.map(([from, to]) => result.answer.slice(from, to))
    expect(spans).toContain('Johanna burned the letter at once.')
    // The first sentence still stands on the labelled passage; the score counts the two bad ones.
    expect(scoreAsk(book, ask)).toMatchObject({ correct: true, citations: { made: 3, kept: 1 } })
    expect(invariants(book, citationsOf([ask]))).toEqual([])
  })

  it('retries a “first” that a passage the search found shows earlier, then says not found', () => {
    const ask = byId(asks, 'ordinal-first-told')
    const result = answerOf(ask)
    // The planted answer cited a real passage (10.1); the honest check listed 9.1 before it.
    const check = ask.captured.find((each) => each.kind === 'cite') ?? fail()
    expect(oracleCiteReply(check.messages)).toEqual({ v: [{ i: 1, ok: 'yes' }], scope: 'earlier' })
    expect(check.messages.at(-1)?.content).toMatch(/^- 9\.1 ¶2: /mu)
    expect(result.scribe).toMatchObject({ notFound: true, retried: true, citations: [] })
    expect(result.answer).toMatch(
      /^Not found in the manuscript \(I looked in .*searched every scene up to 18\.1/u
    )
    // Asked twice, checked twice; the second check is the same request, so the cache answers it.
    expect(ask.captured.map((each) => each.kind).filter((kind) => kind !== 'navigator')).toEqual([
      'answer',
      'cite',
      'answer'
    ])
    expect(ask.rows.filter((row) => row.feature === 'cite').map((row) => row.cached)).toEqual([
      false,
      true
    ])
  })

  it('offers no sheet line the author did not ask for, and says so', () => {
    const result = answerOf(byId(asks, 'open-dunmore-father'))
    expect(result.changes).toEqual([])
    expect(result.answer).toContain(PIN_NOT_ASKED)
  })

  it('answers a second need not found, with what it looked in', () => {
    const ask = byId(asks, 'open-lise-overheard')
    const result = answerOf(ask)
    expect(result.scribe.notFound).toBe(true)
    expect(result.answer).toMatch(/^Not found in the manuscript \(I looked in /u)
    expect(ask.captured.filter((each) => each.kind === 'answer')).toHaveLength(2)
  })

  it('ignores navigator prose: it reaches no later request, and the answer still stands', () => {
    const book = session?.book ?? fail()
    for (const id of ['ordinal-duel', 'idea-captain-past']) {
      const ask = byId(asks, id)
      expect(ask.captured[0]?.text, id).toContain('town talks of it')
      const later = ask.captured.filter((each) => each.kind !== 'navigator')
      expect(later.length, id).toBeGreaterThan(0)
      for (const each of later)
        expect(JSON.stringify(each.messages), id).not.toContain('town talks of it')
      expect(scoreAsk(book, ask), id).toMatchObject({ correct: true, right: true })
    }
    // Unreadable prose: Step 0's evidence answers, with no second navigator step.
    expect(
      byId(asks, 'ordinal-duel').captured.filter((each) => each.kind === 'navigator')
    ).toHaveLength(1)
  })

  it('writes no claim, card or reading, and keeps the invariants', () => {
    const book = session?.book ?? fail()
    expect(after).toEqual(before)
    expect(invariants(book, citationsOf(asks))).toEqual([])
  })
})

// ---- The live run, end to end against a fake OpenRouter -------------------------------------

describe('the live Ms Scribe run, end to end against a fake OpenRouter (F-16.25; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone, sends as the app does, and passes every bar', async () => {
    const { server, live } = oracleLive()
    const report = await runLiveScribe(live, { now: NOW })
    expect(report.failures).toEqual([])
    expect(report.score.questions.every((each) => each.right === true)).toBe(true)
    expect(server.calls.length).toBeGreaterThan(0)
    for (const call of server.calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      expect(call.body).toMatchObject({ usage: { include: true } })
      const kind = scribeRequestKind(call.messages)
      expect(['navigator', 'answer', 'cite']).toContain(kind)
    }
    // The reported cost is what the run counts (0.0001 USD a request at the fake).
    expect(report.run.costUsd).toBeCloseTo(server.calls.length * 0.0001, 6)
    expect(report.markdown).toContain('**Passed.**')
    expect(report.markdown).toContain('on OpenRouter (OPENROUTER_API_KEY)')
    expect(report.markdown).not.toContain('sk-or-fake')
    expect(report.markdown).not.toContain(AGENT_V9_SENTINEL)
    expect(report.markdown).not.toContain(NAVIGATOR_SENTINEL)
    expect(JSON.stringify(report.json)).not.toContain('sk-or-fake')
    expect(JSON.stringify(report.json)).not.toContain(AGENT_V9_SENTINEL)
  }, 120_000)

  it('reads the memory with the live reader and checker first when asked (MYTHSCRIBE_EVAL_READ=live)', async () => {
    const { server, live } = oracleLive()
    const report = await runLiveScribe(live, { now: NOW, read: 'live' })
    expect(report.failures).toEqual([])
    const kinds = server.calls.map((call) => scribeRequestKind(call.messages))
    expect(kinds).toContain('reader')
    expect(kinds).toContain('verify')
    expect(report.markdown).toContain('Memory read by the live reader and checker')
  }, 120_000)

  it('stops once the reported cost passes $1, and says so', async () => {
    const { live } = oracleLive(undefined, 0.2)
    const report = await runLiveScribe(live, { now: NOW })
    expect(report.run.stopped).toBe(true)
    // The question that passed $1 finishes; nothing more is asked.
    expect(report.run.costUsd).toBeGreaterThan(1)
    expect(report.run.costUsd).toBeLessThan(2)
    expect(report.score.questions.some((each) => each.outcome === 'skipped')).toBe(true)
    expect(report.failures).toContain('stopped at the 1 USD cap before the last question')
  }, 120_000)

  it('stops a live reading of the memory at $1 too, and asks nothing after it', async () => {
    const { live } = oracleLive(undefined, 0.3)
    const report = await runLiveScribe(live, { now: NOW, read: 'live' })
    expect(report.run.stopped).toBe(true)
    expect(report.run.costUsd).toBeGreaterThan(1)
    expect(report.run.costUsd).toBeLessThan(2)
    expect(report.score.questions.every((each) => each.outcome === 'skipped')).toBe(true)
  }, 120_000)

  it('stops at a provider error and reports what it asked and what it cost', async () => {
    let answered = 0
    const server = fakeChatServer((messages) => {
      if (answered >= 6) return { text: 'Rate limit exceeded', status: 429 }
      answered += 1
      return { text: scribeOracleReply(messages) }
    })
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLiveScribe(live, { now: NOW })
    expect(report.run.error).toMatch(/^[a-z0-9-]+: RATE_LIMIT: /u)
    expect(report.run.costUsd).toBeCloseTo(0.0006, 6)
    expect(report.score.questions.filter((each) => each.outcome === 'error')).toHaveLength(1)
    expect(report.failures).toContain(`stopped by a provider error (${report.run.error ?? ''})`)
    expect(report.markdown).not.toContain('sk-or-fake')
  }, 120_000)

  it('stops when a cost cannot be known, and says why', async () => {
    const server = fakeChatServer((messages) => ({
      text: scribeOracleReply(messages),
      costUsd: null
    }))
    const live = liveProviderFromEnv(
      { OPENROUTER_API_KEY: 'sk-or-fake', MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/unlisted-model' },
      { fetch: server.fetch }
    )
    const report = await runLiveScribe(live, { now: NOW })
    expect(report.run.costUnknown).toMatch(/^cost unknown for vendor\/unlisted-model/u)
    expect(report.score.questions.some((each) => each.outcome === 'skipped')).toBe(true)
    expect(report.failures.some((failure) => failure.startsWith('cost unknown'))).toBe(true)
  }, 120_000)
})

describe.skipIf(!LIVE)('the live Ms Scribe run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('asks the test book’s questions with the real navigator, answer and check, scores them, and writes the report', async () => {
    const read = process.env.MYTHSCRIBE_EVAL_READ === 'live' ? 'live' : 'oracle'
    const report = await runLiveScribe(liveProviderFromEnv(), { read })
    const dir = path.resolve('test-results/eval-scribe')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(path.join(dir, `scribe-${stamp}.md`), report.markdown)
    fs.writeFileSync(path.join(dir, `scribe-${stamp}.json`), JSON.stringify(report.json, null, 2))
    process.stdout.write(`\n${report.markdown}\n`)
    expect(report.failures).toEqual([])
  }, 1_800_000)
})
