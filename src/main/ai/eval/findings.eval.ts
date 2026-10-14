import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS, type Tier } from '@shared/ai'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { backgroundCandidates, candidatesC7, type Candidate } from '@shared/memory/candidates'
import {
  FINDING_RULES,
  type Finding,
  type FindingRule,
  type FindingSideView,
  type FindingView
} from '@shared/memory/findings'
import { looseEnds } from '@shared/memory/looseEnds'
import { UNDERLINES_MAX } from '@shared/memory/underlines'
import type { CheckEstimate, CheckReport, LooseEndsView } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { JobSkippedError } from '../../jobs/indexQueue'
import { dismissedKeys } from '../../memory/dismissedStore'
import {
  candidateInputs,
  findingsFrame,
  looseEndInputs
} from '../../memory/findings/candidateInputs'
import { checkReport, estimateCheck } from '../../memory/findings/checkBook'
import { looseEndsView } from '../../memory/findings/findingActions'
import { findingRows, findingsOf, invariantFindings } from '../../memory/findings/findingStore'
import { findingsView } from '../../memory/findings/findingViews'
import { runFindingsJob } from '../../memory/findings/findingsJob'
import {
  createFindingsService,
  type FindingsJobResult,
  type FindingsService
} from '../../memory/findings/findingsService'
import { recomputeFindings } from '../../memory/findings/recompute'
import { underlinesOf } from '../../memory/findings/underlines'
import { cardNotRight } from '../../memory/reading/notRight'
import { fakeAi, requestKind } from '../../memory/reading/readingFixture'
import { unreadParagraphs } from '../../memory/reading/views'
import { TEST_BOOK, testBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import {
  addTestBookNotes,
  buildTestBookProject,
  type TestBookProject
} from '../../memory/testBook/project'
import { getNode } from '../../tree/treeStore'
import { buildJudgeConfirmPrompt, buildJudgePrompt, judgeItem } from '../prompts/judge.v1'
import { AiCancelledError, type AiMessage, type Provider } from '../providers/types'
import type { ChatServer } from './fakeChatServer'
import {
  FINDING_NEGATIVES,
  isJudgeRequest,
  labelMatches,
  labelText,
  labelledItem,
  negativeHits,
  negativeText,
  sentJudge,
  sideSays,
  statesAbsence,
  judgeOracleReply,
  judgeOracleServer,
  type JudgePlant,
  type LabelContradiction,
  type SentItem
} from './judgeOracle'
import {
  liveProviderError,
  liveProviderFromEnv,
  liveRequestDeps,
  recordingProvider,
  type CapturedCall,
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

/**
 * Contradictions and Needs a look over the test book (F-16.27, F-16.28, F-16.29, F-16.30; plan P4
 * §1.7, §6.1, §6.2), `npm run eval:ai` (and so `npm run test`):
 *
 * - **The candidates** (slice 1, no AI): the book read by P2a/P2b's oracle (`memoryOracle.ts`), the
 *   P4 records' Pinned notes and the Research page written and indexed, then the rules as the app's
 *   `findings` job runs them: every labelled contradiction a background candidate (C1–C6), a C7 one
 *   only a *Check the book* candidate, h16's (Hobb at the gate in a flashback) made and hidden; no
 *   `finding` negative a candidate except the judge traps; the loose ends the labels' own.
 * - **The oracle replay**: the same book, then the real `findings` job, background judging (the
 *   findings service, at most 10 pairs a run, both orders in two calls) and *Check the book* (C7,
 *   every unjudged pair, the stronger check), all through a fake OpenRouter reached from
 *   `OPENROUTER_API_KEY` alone, answered by the oracle judge (`judgeOracle.ts`: `c` for a labelled
 *   contradiction's pair, `ok` for everything else). Every labelled contradiction ends an open
 *   finding confirmed by the stronger check (C7 after the check); no negative is one; h16's is
 *   hidden, listed with *Not a flashback?*, and judged once the card's flashback is marked not
 *   right; a second check is free; the underlines stay at 3 a scene, on open findings, never in a
 *   paragraph with an unread sentence; the loose ends are the labels'; no item, view, report or
 *   ask states an absence; the invariants hold.
 * - **The adversarial judges**: orders that disagree, all unclear, all contradiction, items dropped,
 *   a reply cut off, a stronger check that clears everything. Each is refused or contained.
 * - **The live contradictions run** (`MYTHSCRIBE_EVAL_LIVE=1`; F-16.27's merge condition, owed by
 *   the author before the switch-over; it cannot run in the build sessions, which have no key):
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- findings
 *       MYTHSCRIBE_EVAL_LIVE=1 MYTHSCRIBE_EVAL_READ=live OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- findings
 *
 *   One pass over the test book with the real `judge.v1` (V4 Flash, both orders) and *Check the
 *   book*'s stronger check (V4 Pro), the memory read by the oracle (so the run measures the judge),
 *   or with the second form by the real `reader.v2` and `verify.v2` first (about 13¢ more; it then
 *   also measures candidates from a real reading). Scored against the pass bars
 *   (`FINDINGS_PASS_BARS`, P4-D24); it stops once the reported cost passes 50¢ (about 1–2¢
 *   expected with the oracle-read memory) and writes `test-results/eval-findings/findings-<date>.md`
 *   and `.json` (no prompt text, no key).
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const fail = (): never => {
  throw new Error('the replay did not run')
}

/** The live run's pass bars (decided by Claude, unconfirmed; P4-D24). */
export const FINDINGS_PASS_BARS = {
  /** Trap negatives (a lie in speech, a remembered colour against a note) as open findings. */
  trapFindings: 0,
  /** Open findings matching no label. */
  unlabelledFindings: 1,
  /** Labelled contradictions C1–C6 (not hidden) that end as open findings. */
  plantedRecall: 0.7,
  /** Pairs whose two orders gave the same verdict. */
  orderAgreement: 0.9,
  /** Of the marks the editor would draw, the share on labelled contradictions (design §2.4's bar). */
  underlinePrecision: 0.7,
  /** Planted findings the stronger check saw that it confirmed. */
  proConfirms: 0.8,
  /** Traps the stronger check confirmed. */
  proTraps: 0,
  reasoningTokens: 0
} as const

/** The live run stops once its reported cost passes this. */
const LIVE_STOP_USD = 0.5

/** Design Part 5: *Check the book* is about 3.3¢ for ~100 pairs on a 90-scene book. */
const DESIGN_CHECK_USD_PER_PAIR = 0.033 / 100

const SCENE_COUNT = TEST_BOOK.filter((scene) => scene.source !== 'inactiveDraft').length

// ---- The test book with its judge ------------------------------------------------------------

/** What a request was: the judge's batch, its stronger check, the reader's, the checker's. */
type CallKind = 'judge' | 'confirm' | 'reader' | 'verify' | 'other'

const callKind = (messages: AiMessage[]): CallKind => {
  const sent = sentJudge(messages)
  if (sent !== null) return sent.confirm ? 'confirm' : 'judge'
  return requestKind({ messages }) ?? 'other'
}

/** Why the judge's requests stop: the live run's cost cap, or a cost that cannot be known. */
const STOPPED = 'The live contradictions run stopped at its cost cap.'

/**
 * The provider with the judge's requests refused (a Stop, as the app's Stop) once `stop()` says
 * so, and the first provider error kept for the report. Reading stops at a scene's end instead
 * (`readBook`'s `stopAt`), so no reading is cut halfway.
 */
function guardedProvider(
  provider: Provider,
  stop: () => boolean,
  failed: (err: unknown) => void
): Provider {
  return {
    id: provider.id,
    resolveModel: (tier) => provider.resolveModel(tier),
    complete: async (request) => {
      if (isJudgeRequest(request.messages) && stop()) throw new AiCancelledError(STOPPED)
      try {
        return await provider.complete(request)
      } catch (err) {
        failed(err)
        throw err
      }
    },
    stream: (request) => provider.stream(request),
    testConnection: () => provider.testConnection(),
    ...(provider.price === undefined ? {} : { price: provider.price })
  }
}

/** The test book as the contradiction check meets it, with the judge's service and run. */
export interface FindingsSession {
  book: TestBookProject
  run: LiveRequestDeps
  captured: CapturedCall<CallKind>[]
  service: FindingsService
  now: Date
  /** The cost cap passed, or a cost cannot be known: nothing more is asked. */
  over(): boolean
  /** The first provider error any request met, as a report says it, or null. */
  providerError(): string | null
  /** The provider error that stopped reading the memory, or null. */
  readError: string | null
  /** Reading the memory stopped at the cost cap before the last scene. */
  readStopped: boolean
  close(): void
}

/**
 * The test book read (by the oracle, free, or by the live reader and checker through `live`), its
 * notes written, Use AI on and the Contradiction check on, and the findings service the app runs,
 * over `live` (every request through the app's request path: fast and strong tiers, reasoning
 * off, the reported cost in the ledger).
 */
export async function openFindingsSession(
  live: Pick<LiveProvider, 'provider' | 'local'>,
  options: { read: 'oracle' | 'live'; now: Date; stopUsd?: number }
): Promise<FindingsSession> {
  const captured: CapturedCall<CallKind>[] = []
  const stopUsd = options.stopUsd ?? Infinity
  let firstError: string | null = null
  const holder: { run: LiveRequestDeps | null } = { run: null }
  const over = (): boolean =>
    holder.run !== null && (holder.run.spent() > stopUsd || holder.run.costUnknown() !== null)
  const provider = guardedProvider(
    recordingProvider(live.provider, captured, callKind),
    over,
    (err) => {
      firstError ??= liveProviderError(err)
    }
  )
  const run = liveRequestDeps({ provider, local: live.local })
  holder.run = run
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-eval-'))
  const book = buildTestBookProject(tmp, options.now)
  const close = (): void => {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  try {
    addTestBookNotes(book, options.now)
    const memory =
      options.read === 'live'
        ? run.deps
        : fakeAi(
            (request) => ({
              text: requestKind(request) === 'verify' ? oracleVerify(request) : oracleRead(request)
            }),
            { now: options.now }
          ).deps
    const outcomes = await readBook(book, memory, { providerErrors: 'stop', stopAt: over })
    const settings: AiSettings = { ...defaultAiSettings(), dial: 1 }
    const service = createFindingsService({
      settings: () => settings,
      provider: () => ({ id: live.provider.id }),
      requestDeps: () => run.deps,
      cloudCapped: () => false,
      rebuilding: () => false,
      spend: () => undefined,
      changed: () => undefined,
      now: () => options.now
    })
    return {
      book,
      run,
      captured,
      service,
      now: options.now,
      over,
      providerError: () => firstError,
      readError: readingStop(outcomes),
      readStopped: outcomes.size < SCENE_COUNT && over(),
      close
    }
  } catch (err) {
    close()
    throw err
  }
}

/** How a stretch of judging ended. */
export interface JudgingOutcome {
  runs: FindingsJobResult[]
  /** A hold ended it (today's background pairs, …), as the job said it; null for none. */
  held: string | null
  /** The cost cap stopped it. */
  stopped: boolean
  /** A provider error stopped it, as a report says it. */
  error: string | null
}

/** A failure of a judge or check job, sorted as the run reports it. */
function outcomeOf(err: unknown, session: FindingsSession, outcome: JudgingOutcome): void {
  if (err instanceof AiCancelledError) {
    outcome.stopped = true
    return
  }
  if (err instanceof JobSkippedError) {
    // A transient provider failure goes quietly in the background: the request met it.
    outcome.error = session.providerError()
    if (outcome.error === null) outcome.held = err.message
    return
  }
  const said = liveProviderError(err)
  if (said === null) throw err
  outcome.error = said
}

/**
 * Background judging as the app runs it: the `findings` job (the recompute, pairs read as the
 * judge reads them, remembered verdicts taken at no cost), then judge runs while unjudged pairs
 * remain and today's limit allows (at most 10 pairs a run, both orders in two calls, 30 a day),
 * the recompute again after each (the app's `memory:changed`).
 */
export async function judgeInBackground(
  session: FindingsSession,
  options: { runs?: number } = {}
): Promise<JudgingOutcome> {
  const { book, service, now } = session
  const outcome: JudgingOutcome = { runs: [], held: null, stopped: false, error: null }
  runFindingsJob(book.db, now, { cachedVerdicts: true })
  const most = options.runs ?? 20
  for (let i = 0; i < most && service.wanted(book.db); i += 1) {
    if (session.over()) {
      outcome.stopped = true
      break
    }
    try {
      const result = await service.judge(book.db, `judge-${outcome.runs.length}`)
      outcome.runs.push(result)
      runFindingsJob(book.db, now, { cachedVerdicts: true })
      if (!result.again) break
    } catch (err) {
      outcomeOf(err, session, outcome)
      break
    }
  }
  return outcome
}

/** How *Check the book* ended, and its report. */
export interface CheckOutcome extends JudgingOutcome {
  report: CheckReport | null
  /** Requests it sent (answered or not). */
  requests: number
}

/** *Check the book*, asked: C7, every unjudged pair, the stronger check, the report. */
export async function checkTheBook(session: FindingsSession): Promise<CheckOutcome> {
  const { book, service } = session
  const before = session.run.ledger.filter((entry) => !entry.cached).length
  const outcome: JudgingOutcome = { runs: [], held: null, stopped: false, error: null }
  service.checkAsked(null)
  try {
    if (session.over()) outcome.stopped = true
    else outcome.runs.push(await service.checkBook(book.db, `check-${before}`))
  } catch (err) {
    outcomeOf(err, session, outcome)
  }
  return {
    ...outcome,
    report: checkReport(book.db),
    requests: session.run.ledger.filter((entry) => !entry.cached).length - before
  }
}

// ---- Scoring ----------------------------------------------------------------------------------

const draftFindings = (book: TestBookProject): Finding[] =>
  findingsOf(book.db, activeDraftId(book.db))

/** A share: right of `of`. */
export interface Share {
  right: number
  of: number
}

export interface FindingsScore {
  /** Per rule: labelled contradictions (not hidden) and those that ended open. */
  recall: Record<FindingRule, Share>
  /** C1–C6 together (the bar's measure). */
  planted: Share
  missed: string[]
  /** Labelled flashback pairs: hidden as they should be. */
  hidden: Share
  /** Open findings matching no label, each with both quotes. */
  unlabelled: string[]
  /** Trap negatives (a candidate the judge must rule fine) that ended open. */
  traps: string[]
  /** Other `finding` negatives that made any finding at all (code's candidate rules let one in). */
  forbidden: string[]
  /** Pairs whose two orders gave the same verdict. */
  orders: Share
  /** Planted pairs `c` both ways, traps not both `c`. */
  labels: Share
  pro: { planted: Share; traps: Share }
  underlines: {
    /** Marks on labelled contradictions, of every mark the editor would draw. */
    precision: Share
    /** Scenes past 3 marks. */
    overCap: string[]
  }
  unclear: Share
  cutOff: Share
  reasoningTokens: number
  /** What *Check the book* reported: its cost and the pairs it checked; null before a check. */
  check: { costUsd: number; pairs: number } | null
}

const sideText = (side: FindingSideView): string => `${side.ref || side.label}: “${side.quote}”`

/** A finding as a report lists it: its rule, its record and both quotes. */
const findingText = (view: FindingView): string =>
  `${view.rule}${view.variant === null ? '' : ` ${view.variant}`} ${view.name} · ${view.slotLabel}: ${sideText(view.a)} / ${sideText(view.b)}`

/** The labelled contradictions a finding is, if any. */
const labelsOf = (book: TestBookProject, finding: Finding): LabelContradiction[] =>
  TEST_BOOK_LABELS.contradictions.filter((label) => labelMatches(book, label, [finding]).length > 0)

/** Every mark the editor would draw in the book's scenes, by scene (the default "in the text"). */
const bookUnderlines = (book: TestBookProject): ReturnType<typeof underlinesOf> =>
  underlinesOf(book.db, [...new Set(book.scenes.values())], { on: true, mode: 'text' })

/** The run's measures (plan P4 §6.2), read from what is stored and what was sent. */
export function scoreFindings(session: FindingsSession, check: CheckOutcome | null): FindingsScore {
  const { book } = session
  const findings = draftFindings(book)
  const shown = findingsView(book.db, null, { on: true, judging: false })
  const views = new Map([...shown.open, ...shown.unclear].map((view) => [view.id, view]))
  const recall = Object.fromEntries(
    FINDING_RULES.map((rule) => [rule, { right: 0, of: 0 }])
  ) as Record<FindingRule, Share>
  const missed: string[] = []
  const hidden: Share = { right: 0, of: 0 }
  const labelled = new Set<string>()
  const labels: Share = { right: 0, of: 0 }
  const proPlanted: Share = { right: 0, of: 0 }
  for (const label of TEST_BOOK_LABELS.contradictions) {
    const found = labelMatches(book, label, findings)
    for (const each of found) labelled.add(each.id)
    if (label.hidden === true) {
      hidden.of += 1
      if (found.some((each) => each.state === 'hidden')) hidden.right += 1
      continue
    }
    recall[label.rule].of += 1
    if (found.some((each) => each.state === 'open')) recall[label.rule].right += 1
    else
      missed.push(
        `${labelText(label)} (${found.map((each) => each.state).join(', ') || 'no candidate'})`
      )
    for (const each of found) {
      if (each.verdictAb !== null && each.verdictBa !== null) {
        labels.of += 1
        if (each.verdictAb === 'c' && each.verdictBa === 'c') labels.right += 1
      }
      if (each.confirm !== null) {
        proPlanted.of += 1
        if (each.confirm === 'c') proPlanted.right += 1
      }
    }
  }
  const planted = (['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const).reduce(
    (sum, rule) => ({ right: sum.right + recall[rule].right, of: sum.of + recall[rule].of }),
    { right: 0, of: 0 }
  )
  const traps: string[] = []
  const forbidden: string[] = []
  const trapIds = new Set<string>()
  const proTraps: Share = { right: 0, of: 0 }
  for (const negative of FINDING_NEGATIVES) {
    const hits = negativeHits(book, negative, findings)
    if (negative.candidate === true) {
      for (const hit of hits) {
        trapIds.add(hit.id)
        if (hit.state === 'open') traps.push(negativeText(negative))
        if (hit.verdictAb !== null && hit.verdictBa !== null) {
          labels.of += 1
          if (!(hit.verdictAb === 'c' && hit.verdictBa === 'c')) labels.right += 1
        }
        if (hit.confirm !== null) {
          proTraps.of += 1
          if (hit.confirm === 'c') proTraps.right += 1
        }
      }
    } else if (hits.length > 0) {
      forbidden.push(negativeText(negative))
    }
  }
  const unlabelled = findings
    .filter((each) => each.state === 'open' && !labelled.has(each.id) && !trapIds.has(each.id))
    .map((each) => {
      const view = views.get(each.id)
      return view === undefined ? `${each.rule} ${each.key}` : findingText(view)
    })
  const judged = findings.filter((each) => each.verdictAb !== null && each.verdictBa !== null)
  const marks = Object.entries(bookUnderlines(book))
  const onLabels = marks
    .flatMap(([, scene]) => scene)
    .filter((mark) => labelled.has(mark.findingId))
  const calls = session.captured.filter((each) => each.kind === 'judge' || each.kind === 'confirm')
  return {
    recall,
    planted,
    missed,
    hidden,
    unlabelled,
    traps,
    forbidden,
    orders: {
      right: judged.filter((each) => each.verdictAb === each.verdictBa).length,
      of: judged.length
    },
    labels,
    pro: { planted: proPlanted, traps: proTraps },
    underlines: {
      precision: { right: onLabels.length, of: marks.flatMap(([, scene]) => scene).length },
      overCap: marks
        .filter(([, scene]) => scene.length > UNDERLINES_MAX)
        .map(([nodeId]) => sceneOf(book, nodeId))
    },
    unclear: {
      right: judged.filter((each) => each.state === 'unclear').length,
      of: judged.length
    },
    cutOff: {
      right: calls.filter((each) => each.finishReason === 'length').length,
      of: calls.length
    },
    reasoningTokens: session.run.ledger
      .filter((entry) => entry.feature === 'judge')
      .reduce((sum, entry) => sum + (entry.reasoningTokens ?? 0), 0),
    check:
      check?.report == null
        ? null
        : { costUsd: check.report.costUsd, pairs: check.report.checked.pairs }
  }
}

// ---- The live run's report --------------------------------------------------------------------

export interface FindingsLiveRun {
  models: Record<Tier, string>
  route: string
  stopUsd: number
  read: 'oracle' | 'live'
  costUsd: number
  requests: number
  /** The cost stop came before the run's end. */
  stopped: boolean
  /** The provider error that stopped the run (where), or null. */
  error: string | null
  costUnknown: string | null
  at?: Date
}

export interface FindingsLiveReport {
  markdown: string
  json: unknown
  failures: string[]
  score: FindingsScore
  run: FindingsLiveRun
}

const percent = (share: Share): string =>
  share.of === 0
    ? 'n/a'
    : `${share.right}/${share.of} (${((share.right / share.of) * 100).toFixed(1)} %)`
const cents = (usd: number | null): string => (usd === null ? 'n/a' : `${(usd * 100).toFixed(2)}¢`)

const listed = (title: string, lines: readonly string[]): string[] => [
  `**${title}:** ${lines.length === 0 ? 'none.' : ''}`,
  ...lines.map((line) => `- ${line}`),
  ''
]

/** The run's report: the measures against the bars (P4-D24), then what to read by hand. */
export function findingsReport(score: FindingsScore, run: FindingsLiveRun): FindingsLiveReport {
  const bars = FINDINGS_PASS_BARS
  const failures: string[] = []
  const bar = (name: string, value: Share, min: number): void => {
    if (value.of > 0 && value.right / value.of < min) {
      failures.push(`${name} ${percent(value)} < ${min * 100} %`)
    }
  }
  bar('planted recall (C1–C6)', score.planted, bars.plantedRecall)
  bar('order agreement', score.orders, bars.orderAgreement)
  bar('underline precision', score.underlines.precision, bars.underlinePrecision)
  bar('stronger check confirms planted', score.pro.planted, bars.proConfirms)
  if (score.traps.length > bars.trapFindings) {
    failures.push(`${score.traps.length} trap negatives as findings`)
  }
  if (score.unlabelled.length > bars.unlabelledFindings) {
    failures.push(`${score.unlabelled.length} unlabelled findings > ${bars.unlabelledFindings}`)
  }
  if (score.pro.traps.right > bars.proTraps) {
    failures.push(`the stronger check confirmed ${score.pro.traps.right} traps`)
  }
  if (score.reasoningTokens > bars.reasoningTokens) {
    failures.push(`${score.reasoningTokens} reasoning tokens`)
  }
  if (score.underlines.overCap.length > 0) {
    failures.push(
      `more than ${UNDERLINES_MAX} underlines in ${score.underlines.overCap.join(', ')}`
    )
  }
  if (score.forbidden.length > 0) {
    failures.push(`${score.forbidden.length} negatives with a candidate code must not make`)
  }
  if (run.stopped) failures.push(`stopped at the ${run.stopUsd} USD cap before the end`)
  if (run.error !== null) failures.push(`stopped by a provider error (${run.error})`)
  if (run.costUnknown !== null) failures.push(run.costUnknown)
  const scaled = score.check === null ? null : score.check.pairs * DESIGN_CHECK_USD_PER_PAIR
  const rules = FINDING_RULES.map((rule) => `${rule} ${percent(score.recall[rule])}`).join('; ')
  const lines = [
    `# Story memory: the live contradictions run (${(run.at ?? new Date()).toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`, on ${run.route}. ` +
      `Memory read by ${run.read === 'live' ? 'the live reader and checker' : 'the oracle'}. ` +
      `Requests: ${run.requests}; reported cost: ${run.costUsd.toFixed(4)} USD (it stops at ${run.stopUsd} USD).`,
    '',
    '## Pass bars (decided by Claude, unconfirmed; P4-D24)',
    '',
    '| Measure | Result | Bar |',
    '| --- | --- | --- |',
    `| Planted recall, C1–C6 (labelled contradictions ending open) | ${percent(score.planted)} | ≥ ${bars.plantedRecall * 100} % |`,
    `| Recall by rule (C7 reported, no bar) | ${rules} | — |`,
    `| Trap negatives as findings | ${score.traps.length} | ${bars.trapFindings} |`,
    `| Unlabelled findings (false alarms; read each below) | ${score.unlabelled.length} | ≤ ${bars.unlabelledFindings} |`,
    `| Judge order agreement (both orders the same verdict) | ${percent(score.orders)} | ≥ ${bars.orderAgreement * 100} % |`,
    `| Judge agreement with the labels (planted c both ways, traps not) | ${percent(score.labels)} | no bar |`,
    `| Stronger check confirms planted findings it saw | ${percent(score.pro.planted)} | ≥ ${bars.proConfirms * 100} % |`,
    `| Stronger check confirms traps | ${score.pro.traps.right} of ${score.pro.traps.of} seen | ${bars.proTraps} |`,
    `| Underline precision (marks on labelled contradictions) | ${percent(score.underlines.precision)} | ≥ ${bars.underlinePrecision * 100} % |`,
    `| Flashback pairs hidden | ${percent(score.hidden)} | no bar |`,
    `| Unclear rate (judged pairs unclear) | ${percent(score.unclear)} | no bar |`,
    `| Cut-off rate (judge calls cut at their cap) | ${percent(score.cutOff)} | no bar |`,
    `| Reasoning tokens (judge) | ${score.reasoningTokens} | ${bars.reasoningTokens} |`,
    `| Check the book's cost (design ≈ 3.3¢ per ~100 pairs, scaled to the pairs checked) | ${
      score.check === null
        ? 'no check'
        : `${cents(score.check.costUsd)} for ${score.check.pairs} pairs (scaled design ${cents(scaled)})`
    } | no bar |`,
    '',
    failures.length === 0 ? '**Passed.**' : `**Failed:** ${failures.join('; ')}.`,
    '',
    ...(run.error === null ? [] : [`**Stopped by a provider error:** ${run.error}.`, '']),
    ...(run.costUnknown === null ? [] : [`**Cost unknown:** ${run.costUnknown}.`, '']),
    ...listed('Labelled contradictions missed', score.missed),
    ...listed('False alarms: open findings no label names (read both quotes)', score.unlabelled),
    ...listed('Trap negatives that became findings', score.traps),
    ...listed('Negatives with a candidate code must not make', score.forbidden),
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
 * The live contradictions run (plan P4 §6.2): one pass over the test book, its memory read by the
 * oracle (free) or, with `read: 'live'`, by the real reader and checker first; then background
 * judging and *Check the book* with the real `judge.v1` through `live`. It stops once the reported
 * cost passes `stopUsd` (a Stop: what was judged stays), once a cost cannot be known, or at a
 * provider error; the report is written either way, with what was judged and what it cost.
 */
export async function runLiveFindings(
  live: LiveProvider,
  options: { stopUsd?: number; now?: Date; read?: 'oracle' | 'live' } = {}
): Promise<FindingsLiveReport> {
  const stopUsd = options.stopUsd ?? LIVE_STOP_USD
  const now = options.now ?? new Date()
  const read = options.read ?? 'oracle'
  const session = await openFindingsSession(live, { read, now, stopUsd })
  try {
    let error = session.readError
    let stopped = session.readStopped
    let check: CheckOutcome | null = null
    if (error === null && !session.over()) {
      const background = await judgeInBackground(session)
      error = background.error
      stopped ||= background.stopped
      if (error === null && !stopped) {
        check = await checkTheBook(session)
        error = check.error
        stopped ||= check.stopped
      }
    }
    const costUnknown = session.run.costUnknown()
    return findingsReport(scoreFindings(session, check), {
      models: live.models,
      route: live.describe,
      stopUsd,
      read,
      costUsd: session.run.spent(),
      requests: session.run.ledger.filter((entry) => !entry.cached).length,
      stopped: stopped && costUnknown === null,
      error,
      costUnknown,
      at: now
    })
  } finally {
    session.close()
  }
}

// ---- The candidates (slice 1: no AI) ---------------------------------------------------------

let book: TestBookProject
let outcomes: Map<string, string>
let background: Candidate[]
let check: Candidate[]
let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-eval-'))
  book = buildTestBookProject(tmp, NOW)
  addTestBookNotes(book, NOW)
  const ai = fakeAi(
    (request) => ({
      text: requestKind(request) === 'verify' ? oracleVerify(request) : oracleRead(request)
    }),
    { now: NOW }
  )
  outcomes = await readBook(book, ai.deps)
  const inputs = candidateInputs(book.db, activeDraftId(book.db))
  background = backgroundCandidates(inputs)
  check = candidatesC7(inputs)
}, 60_000)

afterAll(() => {
  book.session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the contradiction candidates over the test book (F-16.27)', () => {
  it('reads every manuscript scene of the book', () => {
    for (const scene of TEST_BOOK) {
      if (scene.source === 'scene') expect(outcomes.get(scene.id), scene.id).toBe('read')
    }
  })

  it('makes every labelled contradiction a candidate: C1–C6 in the background, C7 on a check', () => {
    const missed = TEST_BOOK_LABELS.contradictions.flatMap((each) => {
      const among = each.rule === 'C7' ? check : background
      return labelMatches(book, each, among).length === 1 ? [] : [labelText(each)]
    })
    expect(missed).toEqual([])
    // C7 is never a background candidate (plan P4-D4).
    expect(background.filter((each) => each.rule === 'C7')).toEqual([])
  })

  it('hides the flashback one, and only it', () => {
    for (const each of TEST_BOOK_LABELS.contradictions) {
      const [found] = labelMatches(book, each, each.rule === 'C7' ? check : background)
      expect([found?.hidden, found?.held], labelText(each)).toEqual([each.hidden === true, false])
    }
  })

  it('makes no candidate a negative forbids, and every judge trap’s', () => {
    const all = [...background, ...check]
    const wrong = FINDING_NEGATIVES.flatMap((negative) => {
      const hits = negativeHits(book, negative, all).length
      return (negative.candidate === true ? hits > 0 : hits === 0) ? [] : [negativeText(negative)]
    })
    expect(wrong).toEqual([])
  })

  it('stores the background candidates once, unjudged or hidden, and a second run moves nothing', () => {
    const first = recomputeFindings(book.db, NOW)
    const rows = findingRows(book.db, activeDraftId(book.db))
    expect(rows.map((row) => row.key).sort()).toEqual(background.map((each) => each.key).sort())
    for (const each of TEST_BOOK_LABELS.contradictions) {
      const [found] = labelMatches(book, each, each.rule === 'C7' ? check : background)
      const row = rows.find((candidate) => candidate.key === found?.key)
      if (each.rule === 'C7') expect(row, labelText(each)).toBeUndefined()
      else expect(row?.state, labelText(each)).toBe(each.hidden === true ? 'hidden' : 'unjudged')
    }
    expect(first.opened).toEqual([])
    expect(recomputeFindings(book.db, NOW).changed).toBe(false)
  })

  it('keeps the memory invariants with the findings in', () => {
    const draftId = activeDraftId(book.db)
    const { reading } = findingsFrame(book.db)
    expect(
      invariants(book, [], {
        findings: invariantFindings(book.db, draftId, (nodeId) => reading.order.has(nodeId)),
        dismissedFindings: dismissedKeys(book.db, 'notProblem')
      })
    ).toEqual([])
  })
})

/** The loose ends as the labels name them: kind, label record (or planned scene), last scene. */
function looseEndRows(of: TestBookProject, view: LooseEndsView): (string | null)[][] {
  const labelOf = new Map(
    TEST_BOOK_LABELS.records.map((record) => [of.records.get(record.id) ?? '', record.id])
  )
  const scene = (nodeId: string | null): string | null =>
    nodeId === null ? null : sceneOf(of, nodeId)
  return view.items.map((item) => [
    item.kind,
    item.kind === 'planned' ? scene(item.id) : (labelOf.get(item.id) ?? item.id),
    scene(item.lastNodeId)
  ])
}

const LOOSE_END_LABELS = TEST_BOOK_LABELS.looseEnds.map((each) => [
  each.kind,
  each.id,
  each.last ?? null
])

describe('the loose ends of the test book (F-16.29)', () => {
  it('lists what the labels say the book leaves hanging, where each was last touched', () => {
    const view = looseEnds(looseEndInputs(book.db, activeDraftId(book.db)))
    expect(looseEndRows(book, view)).toEqual(LOOSE_END_LABELS)
    expect(view.more).toBe(0)
    // Every question it would send is worded as a question, never as an absence.
    for (const item of view.items) expect(item.ask).toMatch(/\?$/)
  })
})

// ---- The oracle replay -----------------------------------------------------------------------

/** A live provider over `server`, from `OPENROUTER_API_KEY` alone. */
const fakeLive = (server: ChatServer, env: Record<string, string> = {}): LiveProvider =>
  liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake', ...env }, { fetch: server.fetch })

/** The models *Check the book*'s price is worked out on. */
const CONTEXT = {
  source: 'ownKey' as const,
  fastModel: OPENROUTER_DEFAULT_MODELS.fast,
  strongModel: OPENROUTER_DEFAULT_MODELS.strong,
  pricing: null
}

/** The judge's items a stretch of calls sent (batches, or the stronger check's). */
const itemsOf = (calls: readonly CapturedCall<CallKind>[], kind: 'judge' | 'confirm'): SentItem[] =>
  calls
    .filter((call) => call.kind === kind)
    .flatMap((call) => sentJudge(call.messages)?.items ?? [])

/** The one finding a labelled contradiction is in `of` (fails the replay when it is not one). */
const findingFor = (of: TestBookProject, label: LabelContradiction): Finding => {
  const found = labelMatches(of, label, draftFindings(of))
  return found.length === 1 ? (found[0] ?? fail()) : fail()
}

/** The text a finding view shows that the app composes (never a book quote). */
const viewWords = (view: FindingView): string[] => [
  view.name,
  view.slotLabel,
  view.why ?? '',
  ...[view.a, view.b].flatMap((side) => [side.label, side.value, side.ref])
]

const doc = (paragraphs: readonly string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

describe('contradictions over the test book: the oracle replay (F-16.27, F-16.28, F-16.29, F-16.30)', () => {
  let server: ChatServer
  let session: FindingsSession
  let judged: JudgingOutcome
  let backgroundCalls: CapturedCall<CallKind>[]
  let afterBackground: Finding[]
  let first: CheckOutcome
  let estimate: CheckEstimate
  let second: CheckOutcome
  let callsBeforeSecond: number

  beforeAll(async () => {
    server = judgeOracleServer()
    session = await openFindingsSession(fakeLive(server), { read: 'oracle', now: NOW })
    judged = await judgeInBackground(session)
    backgroundCalls = [...session.captured]
    afterBackground = draftFindings(session.book)
    first = await checkTheBook(session)
    estimate = estimateCheck(session.book.db, CONTEXT)
    callsBeforeSecond = server.calls.length
    second = await checkTheBook(session)
  }, 120_000)

  afterAll(() => session.close())

  it('judges in the background as the app does: C1–C6 only, at most 10 pairs a run, each batch in both orders', () => {
    expect(judged).toMatchObject({ held: null, stopped: false, error: null })
    expect(judged.runs.length).toBeGreaterThan(0)
    for (const run of judged.runs) expect(run.run?.sent ?? 0).toBeLessThanOrEqual(10)
    expect(backgroundCalls.every((call) => call.kind === 'judge')).toBe(true)
    const items = itemsOf(backgroundCalls, 'judge')
    for (const call of backgroundCalls) {
      expect(sentJudge(call.messages)?.items.length ?? 0).toBeLessThanOrEqual(10)
    }
    // No C7 pair in the background (Check the book's only).
    expect(items.filter((item) => labelledItem(item)?.rule === 'C7')).toEqual([])
    // Every pair went twice, its passages swapped the second time.
    const seen = new Map<string, string[]>()
    for (const item of items) {
      const key = [item.question, ...[item.a.text, item.b.text].sort()].join('\n')
      seen.set(key, [...(seen.get(key) ?? []), item.a.text])
    }
    for (const [key, firsts] of seen) {
      expect(firsts.length, key).toBe(2)
      expect(firsts[0], key).not.toBe(firsts[1])
    }
    expect(afterBackground.filter((each) => each.rule === 'C7')).toEqual([])
  })

  it('ends every labelled contradiction open and confirmed by the stronger check (C7 after the check)', () => {
    expect(first).toMatchObject({ held: null, stopped: false, error: null })
    for (const label of TEST_BOOK_LABELS.contradictions) {
      if (label.hidden === true) continue
      const finding = findingFor(session.book, label)
      expect(
        [finding.state, finding.verdictAb, finding.verdictBa, finding.confirm],
        labelText(label)
      ).toEqual(['open', 'c', 'c', 'c'])
    }
    // Only the labelled pairs are open, and the report lists each, confirmed.
    const open = draftFindings(session.book).filter((each) => each.state === 'open')
    expect(open).toHaveLength(
      TEST_BOOK_LABELS.contradictions.filter((each) => each.hidden !== true).length
    )
    expect(first.report?.found.every((view) => view.confirmed)).toBe(true)
    expect(first.report?.found.map((view) => view.id).sort()).toEqual(
      open.map((each) => each.id).sort()
    )
    expect(first.report?.stopped).toBe(false)
    expect(first.report?.notChecked).toMatchObject({ pastConfirm: 0, unjudged: 0 })
  })

  it('makes no finding of a negative: no candidate at all, or a trap judged fine both ways', () => {
    const findings = draftFindings(session.book)
    const wrong = FINDING_NEGATIVES.flatMap((negative) => {
      const hits = negativeHits(session.book, negative, findings)
      if (negative.candidate !== true) return hits.length === 0 ? [] : [negativeText(negative)]
      return hits.length > 0 &&
        hits.every(
          (hit) => hit.state === 'fine' && hit.verdictAb === 'ok' && hit.verdictBa === 'ok'
        )
        ? []
        : [negativeText(negative)]
    })
    expect(wrong).toEqual([])
  })

  it('meets every bar of the live run against the oracle', () => {
    const report = findingsReport(scoreFindings(session, first), {
      models: OPENROUTER_DEFAULT_MODELS,
      route: 'OpenRouter (OPENROUTER_API_KEY)',
      stopUsd: LIVE_STOP_USD,
      read: 'oracle',
      costUsd: session.run.spent(),
      requests: server.calls.length,
      stopped: false,
      error: null,
      costUnknown: null,
      at: NOW
    })
    expect(report.failures).toEqual([])
    expect(report.score.planted.right).toBe(report.score.planted.of)
    expect(report.score.recall.C7).toEqual({ right: 1, of: 1 })
    expect(report.score.orders.right).toBe(report.score.orders.of)
    expect(report.score.labels.right).toBe(report.score.labels.of)
    expect(report.score.underlines.precision.right).toBe(report.score.underlines.precision.of)
    expect(report.score.hidden).toEqual({ right: 1, of: 1 })
  })

  it('sends as the app does: the fast model for the judge, the strong for the stronger check, reasoning off', () => {
    expect(server.calls.length).toBeGreaterThan(0)
    for (const call of server.calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      const confirm = sentJudge(call.messages)?.confirm ?? fail()
      expect(call.body).toMatchObject({
        model: confirm ? OPENROUTER_DEFAULT_MODELS.strong : OPENROUTER_DEFAULT_MODELS.fast,
        reasoning: { enabled: false },
        usage: { include: true }
      })
    }
    // The reported cost is what the run counts (0.0001 USD a request at the fake).
    expect(session.run.spent()).toBeCloseTo(server.calls.length * 0.0001, 6)
  })

  it('a second check costs nothing: priced free, nothing sent, the same findings', () => {
    expect(estimate).toMatchObject({ free: true, fastCalls: 0, confirms: { most: 0 } })
    expect(server.calls.length).toBe(callsBeforeSecond)
    expect(second.requests).toBe(0)
    expect(second.runs[0]?.requested).toBe(false)
    expect(second.report?.costUsd).toBe(0)
    expect(second.report?.found.map((view) => view.id).sort()).toEqual(
      first.report?.found.map((view) => view.id).sort()
    )
  })

  it('keeps the invariants with the judged findings in', () => {
    const { db } = session.book
    const { reading } = findingsFrame(db)
    expect(
      invariants(session.book, [], {
        findings: invariantFindings(db, activeDraftId(db), (nodeId) => reading.order.has(nodeId)),
        dismissedFindings: dismissedKeys(db, 'notProblem')
      })
    ).toEqual([])
  })

  it('lists the loose ends the labels name, after judging too, each asked as a question', () => {
    const view = looseEndsView(session.book.db)
    expect(looseEndRows(session.book, view)).toEqual(LOOSE_END_LABELS)
    for (const item of view.items) {
      expect(item.ask).toMatch(/\?$/)
      expect(statesAbsence(item.ask), item.ask).toBe(false)
    }
  })

  it('states no absence in a judge item, a finding, the report or a loose end’s ask', () => {
    const composed: string[] = []
    for (const item of [
      ...itemsOf(session.captured, 'judge'),
      ...itemsOf(session.captured, 'confirm')
    ]) {
      composed.push(item.question, item.a.head, sideSays(item.a), item.b.head, sideSays(item.b))
    }
    const views = findingsView(session.book.db, null, { on: true, judging: false })
    for (const view of [...views.open, ...views.unclear]) composed.push(...viewWords(view))
    const report = first.report ?? fail()
    for (const view of [...report.found, ...report.unclear, ...report.cleared]) {
      composed.push(...viewWords(view))
    }
    composed.push(
      ...report.hidden.map((each) => each.label),
      ...report.secretsNobodyLearns.map((each) => each.label),
      ...looseEndsView(session.book.db).items.map((item) => item.ask)
    )
    expect(composed.length).toBeGreaterThan(50)
    expect(composed.filter((text) => statesAbsence(text))).toEqual([])
  })

  it('draws at most 3 underlines a scene, on open findings only, every one on a labelled contradiction', () => {
    const marks = bookUnderlines(session.book)
    const open = new Map(
      draftFindings(session.book)
        .filter((each) => each.state === 'open')
        .map((each) => [each.id, each])
    )
    const all = Object.values(marks).flat()
    expect(all.length).toBeGreaterThan(0)
    for (const [nodeId, scene] of Object.entries(marks)) {
      expect(scene.length, sceneOf(session.book, nodeId)).toBeLessThanOrEqual(UNDERLINES_MAX)
    }
    for (const mark of all) {
      const finding = open.get(mark.findingId) ?? fail()
      expect(labelsOf(session.book, finding).length).toBe(1)
    }
    // h15 holds more open findings than marks: the cap holds there.
    expect(marks[session.book.scenes.get('h15') ?? '']?.length).toBe(UNDERLINES_MAX)
  })

  it('hides the flashback pair, lists it with Not a flashback?, and judges it once the card is marked not right', async () => {
    const label = TEST_BOOK_LABELS.contradictions.find((each) => each.hidden === true) ?? fail()
    const h16 = session.book.scenes.get('h16') ?? fail()
    const finding = findingFor(session.book, label)
    expect(finding.state).toBe('hidden')
    expect(first.report?.hidden).toEqual([
      expect.objectContaining({ findingId: finding.id, nodeId: h16 })
    ])
    const calls = server.calls.length
    // Not a flashback?: the card's flashback marked not right (P4-D13), then the job and the judge.
    cardNotRight(session.book.db, { nodeId: h16, field: 'flashback', value: 'yes' }, NOW)
    const after = await judgeInBackground(session)
    expect(after.error).toBeNull()
    expect(server.calls.length).toBe(calls + 2)
    expect(findingFor(session.book, label)).toMatchObject({
      state: 'open',
      verdictAb: 'c',
      verdictBa: 'c'
    })
  })

  it('never underlines in a paragraph with an unread sentence: another open finding takes its place', () => {
    const { db } = session.book
    const h15 = session.book.scenes.get('h15') ?? fail()
    const before = bookUnderlines(session.book)[h15] ?? fail()
    const para = before[0]?.para ?? fail()
    // A sentence added to that paragraph and not read yet.
    const paragraphs = testBookScene('h15').paragraphs.map((text, p) =>
      p === para ? `${text} The carriage came late again that evening.` : text
    )
    saveDocument(db, h15, doc(paragraphs))
    const row = getNode(db, h15) ?? fail()
    expect([...unreadParagraphs(db, row, activeDraftId(db), new Set([para]))]).toEqual([para])
    const after = bookUnderlines(session.book)[h15] ?? fail()
    expect(after.map((mark) => mark.para)).not.toContain(para)
    expect(after.length).toBe(UNDERLINES_MAX)
  })
})

describe('the judge oracle reads each request as it was sent (F-16.27)', () => {
  /** One pair rendered by `judge.v1` from two test-book passages, as a side of each kind. */
  const pair = (quoteA: string, quoteB: string): Parameters<typeof buildJudgePrompt>[0][number] =>
    judgeItem({
      question: { rule: 'C1', name: 'Callum Varrow', slot: 'eyes' },
      a: {
        place: '3.1 ¶4',
        at: { order: 2, para: 4 },
        says: 'grey',
        voice: 'narration',
        mode: 'now',
        flashback: false,
        year: null,
        quote: quoteA,
        text: `${quoteA}, and he did not smile.`
      },
      b: {
        place: '14.1 ¶2',
        at: { order: 12, para: 2 },
        says: 'brown',
        voice: 'narration',
        mode: 'now',
        flashback: false,
        year: 1812,
        quote: quoteB,
        text: `${quoteB} across the room.`
      },
      between: ['Three winters later']
    })

  it('parses a batch in both orders and the stronger check, and answers by the labels', () => {
    const planted = pair(
      "Mr. Varrow's eyes were a cold, clear grey",
      "Varrow's brown eyes followed her"
    )
    const other = pair("Mr. Varrow's eyes were a cold, clear grey", 'Varrow bowed to the room')
    for (const order of ['ab', 'ba'] as const) {
      const prompt = buildJudgePrompt([planted, other], order)
      const sent = sentJudge(prompt.messages) ?? fail()
      expect(sent.confirm).toBe(false)
      expect(sent.items.map((item) => [item.n, labelledItem(item)?.rule ?? null])).toEqual([
        [1, 'C1'],
        [2, null]
      ])
      expect(sideSays(sent.items[0]?.a ?? fail())).toBe(order === 'ab' ? 'grey' : 'brown')
      expect(sent.items[0]?.between).toBe('“Three winters later”')
      expect(JSON.parse(judgeOracleReply(prompt.messages)?.text ?? '')).toEqual({
        v: [
          { i: 1, r: 'c', w: 'the two passages disagree' },
          { i: 2, r: 'ok' }
        ]
      })
    }
    const confirm = buildJudgeConfirmPrompt(planted.pair)
    expect(sentJudge(confirm.messages)?.confirm).toBe(true)
    expect(JSON.parse(judgeOracleReply(confirm.messages)?.text ?? '')).toMatchObject({ r: 'c' })
    expect(JSON.parse(judgeOracleReply(confirm.messages, 'proOk')?.text ?? '')).toMatchObject({
      r: 'ok'
    })
    // Not a judge request: no verdicts.
    expect(sentJudge([{ role: 'system', content: 'You are the story-memory reader.' }])).toBeNull()
  })

  it('plants as asked: a cut reply stops mid-entry at its cap, a dropping judge skips every second item', () => {
    const items = [
      pair("Mr. Varrow's eyes were a cold, clear grey", "Varrow's brown eyes followed her"),
      pair("Mr. Varrow's eyes were a cold, clear grey", 'Varrow bowed to the room'),
      pair("Mr. Varrow's eyes were a cold, clear grey", 'Varrow sat down')
    ]
    const prompt = buildJudgePrompt(items, 'ab')
    const cut = judgeOracleReply(prompt.messages, 'cut') ?? fail()
    expect(cut.finishReason).toBe('length')
    expect(() => JSON.parse(cut.text) as unknown).toThrow()
    const dropped = JSON.parse(judgeOracleReply(prompt.messages, 'drop')?.text ?? '') as {
      v: { i: number }[]
    }
    expect(dropped.v.map((each) => each.i)).toEqual([1, 3])
    const memory = new Map<string, number>()
    const once = judgeOracleReply(prompt.messages, 'disagree', memory)?.text ?? ''
    const twice = judgeOracleReply(buildJudgePrompt(items, 'ba').messages, 'disagree', memory)?.text
    expect(once).toContain('"r":"c"')
    expect(once).not.toContain('"r":"ok"')
    expect(twice).not.toContain('"r":"c"')
  })

  it('knows an absence in what the app composes, and lets a positive question stand', () => {
    for (const text of [
      'Nobody learns it.',
      'Mr. Harrow does not know about the debts.',
      'I found no scene where Tomas learns it.',
      'Her hair changes with no change shown.',
      'Orrin is never mentioned again.'
    ]) {
      expect(statesAbsence(text), text).toBe(true)
    }
    for (const text of [
      "Ashby's return was last advanced in 7.3. Where does it go next?",
      'Orrin is last named in 6.2. Where is he after that?',
      'One passage has Hobb die; the other has Hobb present. Can both be true?',
      'Anne Fenwick’s hair differs between these two appearances. Can both be true?'
    ]) {
      expect(statesAbsence(text), text).toBe(false)
    }
  })
})

// ---- The adversarial judges ------------------------------------------------------------------

/** A session over a judge that plants `plant` (switchable between runs), with its server. */
async function plantedSession(plant: {
  current: JudgePlant | null
}): Promise<{ server: ChatServer; session: FindingsSession }> {
  const server = judgeOracleServer({ plant: () => plant.current })
  const session = await openFindingsSession(fakeLive(server), { read: 'oracle', now: NOW })
  return { server, session }
}

const statesOf = (of: TestBookProject): Finding['state'][] =>
  draftFindings(of).map((each) => each.state)

describe('contradictions over the test book: the adversarial judges (F-16.27, F-16.30)', () => {
  it('opens nothing when the two orders disagree (c one way, ok the other)', async () => {
    const { server, session } = await plantedSession({ current: 'disagree' })
    try {
      await judgeInBackground(session)
      const checked = await checkTheBook(session)
      const judgedRows = draftFindings(session.book).filter((each) => each.verdictAb !== null)
      expect(judgedRows.length).toBeGreaterThan(0)
      for (const each of judgedRows) {
        expect([each.state, [each.verdictAb, each.verdictBa].sort()]).toEqual(['fine', ['c', 'ok']])
      }
      expect(statesOf(session.book)).not.toContain('open')
      expect(checked.report?.found).toEqual([])
      // Nothing open, so nothing for the stronger check, and nothing to underline.
      expect(server.calls.filter((call) => sentJudge(call.messages)?.confirm)).toEqual([])
      expect(Object.values(bookUnderlines(session.book)).flat()).toEqual([])
    } finally {
      session.close()
    }
  }, 60_000)

  it('shows an all-unclear judge as unclear only: never open, never in the badge, never underlined', async () => {
    const { server, session } = await plantedSession({ current: 'unclear' })
    try {
      await judgeInBackground(session)
      const checked = await checkTheBook(session)
      expect(statesOf(session.book)).not.toContain('open')
      const unclear = draftFindings(session.book).filter((each) => each.state === 'unclear')
      expect(unclear.length).toBeGreaterThan(0)
      const view = findingsView(session.book.db, null, { on: true, judging: false })
      expect(view.open).toEqual([])
      expect(view.unclear.length).toBe(unclear.length)
      expect(checked.report?.unclear.length).toBe(unclear.length)
      expect(server.calls.filter((call) => sentJudge(call.messages)?.confirm)).toEqual([])
      expect(Object.values(bookUnderlines(session.book)).flat()).toEqual([])
    } finally {
      session.close()
    }
  }, 60_000)

  it('lets a judge that calls everything a contradiction open only what code made a candidate', async () => {
    const { session } = await plantedSession({ current: 'allC' })
    try {
      await judgeInBackground(session)
      const checked = await checkTheBook(session)
      const { db } = session.book
      const inputs = candidateInputs(db, activeDraftId(db))
      const candidates = [...backgroundCandidates(inputs), ...candidatesC7(inputs)].filter(
        (each) => !each.hidden && !each.held
      )
      const open = draftFindings(session.book).filter((each) => each.state === 'open')
      expect(open.map((each) => each.key).sort()).toEqual(candidates.map((each) => each.key).sort())
      // The dialogue-only values, the dream, the change claim, the rumour, the future note and the
      // agreeing kin word never reached the judge: no finding at all.
      const findings = draftFindings(session.book)
      expect(
        FINDING_NEGATIVES.filter(
          (negative) =>
            negative.candidate !== true && negativeHits(session.book, negative, findings).length > 0
        ).map(negativeText)
      ).toEqual([])
      // The stronger check confirmed at most 20.
      expect(checked.report?.confirmed ?? 0).toBeLessThanOrEqual(20)
      for (const [, scene] of Object.entries(bookUnderlines(session.book))) {
        expect(scene.length).toBeLessThanOrEqual(UNDERLINES_MAX)
      }
    } finally {
      session.close()
    }
  }, 60_000)

  it('leaves the pairs a judge drops unjudged and counted, and judges them the next run', async () => {
    const plant: { current: JudgePlant | null } = { current: 'drop' }
    const { session } = await plantedSession(plant)
    try {
      const dropped = await judgeInBackground(session, { runs: 1 })
      const run = dropped.runs[0]?.run ?? fail()
      expect(run.unanswered).toBeGreaterThan(0)
      expect(statesOf(session.book)).toContain('unjudged')
      plant.current = null
      await judgeInBackground(session)
      await checkTheBook(session)
      for (const label of TEST_BOOK_LABELS.contradictions) {
        if (label.hidden !== true)
          expect(findingFor(session.book, label).state, labelText(label)).toBe('open')
      }
      expect(statesOf(session.book)).not.toContain('unjudged')
    } finally {
      session.close()
    }
  }, 60_000)

  it('reads a reply cut off at its cap to its last whole verdict, and judges the rest the next run', async () => {
    const plant: { current: JudgePlant | null } = { current: 'cut' }
    const { server, session } = await plantedSession(plant)
    try {
      const cut = await judgeInBackground(session, { runs: 1 })
      const run = cut.runs[0]?.run ?? fail()
      expect(run.unanswered).toBeGreaterThan(0)
      expect(session.captured.some((call) => call.finishReason === 'length')).toBe(true)
      // Some verdicts were read from the cut replies; the rest wait.
      expect(draftFindings(session.book).some((each) => each.verdictAb !== null)).toBe(true)
      expect(statesOf(session.book)).toContain('unjudged')
      const calls = server.calls.length
      plant.current = null
      await judgeInBackground(session)
      await checkTheBook(session)
      // The cut replies were never kept: the next run asked again.
      expect(server.calls.length).toBeGreaterThan(calls)
      for (const label of TEST_BOOK_LABELS.contradictions) {
        if (label.hidden !== true)
          expect(findingFor(session.book, label).state, labelText(label)).toBe('open')
      }
    } finally {
      session.close()
    }
  }, 60_000)

  it('clears what the stronger check calls fine, and the report lists it as cleared', async () => {
    const { session } = await plantedSession({ current: 'proOk' })
    try {
      await judgeInBackground(session)
      const checked = await checkTheBook(session)
      const report = checked.report ?? fail()
      expect(statesOf(session.book)).not.toContain('open')
      const planted = TEST_BOOK_LABELS.contradictions.filter((each) => each.hidden !== true)
      for (const label of planted) {
        expect(findingFor(session.book, label), labelText(label)).toMatchObject({
          state: 'fine',
          confirm: 'ok'
        })
      }
      expect(report.found).toEqual([])
      expect(report.cleared.length).toBe(planted.length)
      expect(Object.values(bookUnderlines(session.book)).flat()).toEqual([])
    } finally {
      session.close()
    }
  }, 60_000)
})

// ---- The live run, offline --------------------------------------------------------------------

describe('the live contradictions run, end to end against a fake OpenRouter (F-16.27; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone, judges as the app does, and passes every bar', async () => {
    const server = judgeOracleServer()
    const report = await runLiveFindings(fakeLive(server), { now: NOW })
    expect(report.failures).toEqual([])
    expect(report.run).toMatchObject({
      read: 'oracle',
      stopped: false,
      error: null,
      costUnknown: null
    })
    expect(server.calls.length).toBeGreaterThan(0)
    expect(server.calls.every((call) => isJudgeRequest(call.messages))).toBe(true)
    expect(report.run.costUsd).toBeCloseTo(server.calls.length * 0.0001, 6)
    expect(report.markdown).toContain('**Passed.**')
    expect(report.markdown).toContain('on OpenRouter (OPENROUTER_API_KEY)')
    expect(report.markdown).toContain('Memory read by the oracle')
    expect(report.markdown).not.toContain('sk-or-fake')
    expect(report.markdown).not.toContain('You are the contradiction judge')
    expect(JSON.stringify(report.json)).not.toContain('sk-or-fake')
  }, 120_000)

  it('reads the memory with the live reader and checker first when asked (MYTHSCRIBE_EVAL_READ=live)', async () => {
    const server = judgeOracleServer()
    const report = await runLiveFindings(fakeLive(server), { now: NOW, read: 'live' })
    expect(report.failures).toEqual([])
    expect(server.calls.some((call) => requestKind({ messages: call.messages }) === 'reader')).toBe(
      true
    )
    expect(report.markdown).toContain('Memory read by the live reader and checker')
  }, 120_000)

  it('stops once the reported cost passes 50¢, keeps what was judged, and says so', async () => {
    const server = judgeOracleServer({ costUsd: 0.3 })
    const report = await runLiveFindings(fakeLive(server), { now: NOW })
    // Two calls pass 50¢; nothing more is asked.
    expect(server.calls.length).toBe(2)
    expect(report.run.stopped).toBe(true)
    expect(report.run.costUsd).toBeCloseTo(0.6, 6)
    expect(report.failures.some((failure) => failure.includes('stopped at the 0.5 USD cap'))).toBe(
      true
    )
    expect(report.score.orders.of).toBeGreaterThan(0)
  }, 120_000)

  it('stops a live reading of the memory at 50¢ too, and judges nothing after it', async () => {
    const server = judgeOracleServer({ costUsd: 0.3 })
    const report = await runLiveFindings(fakeLive(server), { now: NOW, read: 'live' })
    expect(server.calls.every((call) => !isJudgeRequest(call.messages))).toBe(true)
    expect(report.run.stopped).toBe(true)
    expect(report.failures.some((failure) => failure.includes('stopped at the 0.5 USD cap'))).toBe(
      true
    )
  }, 120_000)

  it('stops at a provider error and reports what it judged and what it cost', async () => {
    const server = judgeOracleServer({ failAfter: { calls: 2, status: 429 } })
    const report = await runLiveFindings(fakeLive(server), { now: NOW })
    expect(report.run.error).toMatch(/^RATE_LIMIT: /u)
    expect(report.run.stopped).toBe(false)
    // The two answered requests were paid for: the report counts them.
    expect(report.run.costUsd).toBeCloseTo(0.0002, 6)
    expect(report.failures).toContain(`stopped by a provider error (${report.run.error ?? ''})`)
    expect(report.markdown).toContain(`**Stopped by a provider error:** ${report.run.error ?? ''}`)
    expect(report.markdown).not.toContain('sk-or-fake')
  }, 120_000)

  it('stops when a cost cannot be known, and says why', async () => {
    const server = judgeOracleServer({ costUsd: null })
    const report = await runLiveFindings(
      fakeLive(server, { MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/unlisted-model' }),
      { now: NOW }
    )
    // The first call is answered before the stop can see it; nothing more is asked.
    expect(server.calls.length).toBe(1)
    expect(report.run.costUnknown).toMatch(/^cost unknown for vendor\/unlisted-model/u)
    expect(report.failures.some((failure) => failure.includes('cost unknown'))).toBe(true)
    expect(report.markdown).toContain('**Cost unknown:**')
  }, 120_000)
})

describe.skipIf(!LIVE)('the live contradictions run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('judges the test book with the real judge and stronger check, scores the findings, and writes the report', async () => {
    const read = process.env.MYTHSCRIBE_EVAL_READ === 'live' ? 'live' : 'oracle'
    const report = await runLiveFindings(liveProviderFromEnv(), { read })
    const dir = path.resolve('test-results/eval-findings')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(path.join(dir, `findings-${stamp}.md`), report.markdown)
    fs.writeFileSync(path.join(dir, `findings-${stamp}.json`), JSON.stringify(report.json, null, 2))
    process.stdout.write(`\n${report.markdown}\n`)
    expect(report.failures).toEqual([])
  }, 1_800_000)
})
