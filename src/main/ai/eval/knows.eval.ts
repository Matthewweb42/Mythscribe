import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS, type Tier } from '@shared/ai'
import type { Claim } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { HOLDS, LEARNS, PARTIAL, knowsLine, parseHow } from '@shared/memory/knows'
import { normName } from '@shared/memory/names'
import { stepCounts, threadsAsOf } from '@shared/memory/threadsAsOf'
import type { KnowsAsOf } from '@shared/memory/whoKnows'
import type { ThreadStatus } from '@shared/memory/views'
import { sinceNodeId } from '@shared/memory/years'
import { activeDraftId } from '../../draft/draftStore'
import { dismiss } from '../../memory/dismissedStore'
import { nameScanShared } from '../../memory/nameIndexer'
import { draftClaims, slotClaims } from '../../memory/reading/claimStore'
import { storedKnows as storedKnowsView } from '../../memory/reading/knowsViews'
import { lastReading } from '../../memory/reading/readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentParagraphs,
  topicIds,
  type FakeAi,
  type FakeAnswer
} from '../../memory/reading/readingFixture'
import { listTopicQuotes, listTopics } from '../../memory/reading/topicStore'
import { readingOrder } from '../../memory/reading/readingFrame'
import { storedAge, storedYears } from '../../memory/reading/timeViews'
import type { CompletionRequest } from '../providers/types'
import { VERIFY_SENTINEL } from '../prompts/verify.v1'
import { listNodes } from '../../tree/treeStore'
import { TEST_BOOK } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import { buildTestBookProject, type TestBookProject } from '../../memory/testBook/project'
import { fakeChatServer } from './fakeChatServer'
import { liveProviderFromEnv, liveRequestDeps, type LiveProvider } from './liveProvider'
import {
  BOOK_ORDER,
  TOPIC_LABELS,
  answerText,
  invariants,
  neverRead,
  oracleAnswer,
  oracleChatServer,
  oracleRead,
  oracleVerify,
  overlaps,
  readBook,
  readingStop,
  requestScene,
  sceneOf,
  storedFor,
  topicByLabel,
  topicQuotes,
  type KnowsLabel,
  type OracleTruth,
  type ReadOrder
} from './memoryOracle'

/**
 * Who knows what, threads and time over the test book (F-16.22, F-16.23; plan P2b §3.2, §3.3),
 * `npm run eval:ai` (and so `npm run test`):
 *
 * - The **oracle replays** (`memoryOracle.ts`): the reader proposes exactly the labels' knows
 *   lines, thread steps and topics; the honest checker answers by the labels. Read in book order
 *   and in reverse order (h14 first, so the engagement and the debts are made late and the earlier
 *   scenes' reveals merge into them through the checker's Same items): every labelled learning or
 *   holding line is stored and counts, every partial one is partial, every step is stored with its
 *   status, each topic is made once (duplicate rate 1.0, no extra topic), no negative counts, the
 *   grid as of h14, the story years and the ages match the labels, and the invariants hold.
 * - The **adversarial replay**: the same checker behind a reader that also plants a learner not on
 *   the page, a rumour and a dream passed off as told, a group its sentence never names, a fourth
 *   new secret on one page, a duplicate of a listed secret under a new label, a secret on a reveal
 *   the author dismissed, a step on a secret's id, and a line saying Mr. Harrow does not know.
 *   Each is refused or stored uncounted; the counted picture is the labels' own.
 * - The **live knows run** (`MYTHSCRIBE_EVAL_LIVE=1`; F-16.22's merge condition, owed by the
 *   author before the switch-over; it cannot run in the build sessions, which have no key):
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- knows
 *
 *   Two passes on fresh copies of the test book (book order, then reverse order) with the real
 *   `reader.v2` and `verify.v2`, scored by the same functions as the replays against the pass bars
 *   (`KNOWS_PASS_BARS`, P2b-D23); it stops once the reported cost passes 50¢ (about 3¢ expected on
 *   V4 Flash) and writes `test-results/eval-knows/knows-<date>.md` and `.json` (no prompt text, no
 *   key). `OPENAI_API_KEY` still works (`liveProvider.ts`).
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const fail = (): never => {
  throw new Error('the replay did not run')
}

/** The live run's pass bars (decided by Claude, unconfirmed; P2b-D23). */
export const KNOWS_PASS_BARS = {
  knowsRecall: 0.7,
  attributionPrecision: 0.9,
  howAccuracy: 0.8,
  fromAccuracy: 0.8,
  /** Topic records per labelled secret or thread, in each pass. */
  duplicateRate: 1.25
} as const

/** The live run stops once its reported cost passes this. */
const LIVE_STOP_USD = 0.5

/** The class of a how: learning, holding, or partial (P2b-D7). */
const howClass = (how: string | null): 'learns' | 'holds' | 'partial' | null => {
  const parsed = parseHow(how)
  if (parsed === null) return null
  if (LEARNS.includes(parsed)) return 'learns'
  if (HOLDS.includes(parsed)) return 'holds'
  return PARTIAL.includes(parsed) ? 'partial' : null
}

const order = (scene: string): number => BOOK_ORDER.get(scene) ?? Infinity

/** Project record id → label id, for the records the test book made. */
const labelsOf = (book: TestBookProject): Map<string, string> =>
  new Map([...book.records].map(([labelId, recordId]) => [recordId, labelId]))

/** The active draft's live knows lines and thread steps. */
const liveSlot = (book: TestBookProject, slot: 'knows' | 'thread'): Claim[] =>
  slotClaims(book.db, slot, activeDraftId(book.db)).filter((claim) => claim.state === 'live')

/**
 * Each secret and thread record the readings made, mapped to the labelled topic its evidence
 * (reveals, knows lines, steps) stands on most; null for one that stands on none (an extra topic).
 */
function topicMap(book: TestBookProject): Map<string, string | null> {
  const draftId = activeDraftId(book.db)
  const quotes = listTopicQuotes(book.db, draftId)
  const claims = draftClaims(book.db, draftId)
  const out = new Map<string, string | null>()
  for (const topic of listTopics(book.db)) {
    const evidence = [
      ...quotes.filter((quote) => quote.recordId === topic.recordId).map((quote) => quote.quote),
      ...claims
        .filter(
          (claim) =>
            (claim.slot === 'knows' && claim.objectId === topic.recordId) ||
            (claim.slot === 'thread' && claim.recordId === topic.recordId)
        )
        .map((claim) => claim.quote)
    ]
    let best: { id: string; score: number } | null = null
    for (const label of TOPIC_LABELS.filter((each) => each.kind === topic.kind)) {
      const lines = topicQuotes(label.id)
      const score = evidence.filter((quote) =>
        lines.some((line) => overlaps(line.quote, quote))
      ).length
      if (score > 0 && (best === null || score > best.score)) best = { id: label.id, score }
    }
    out.set(topic.recordId, best?.id ?? null)
  }
  return out
}

/** The thread's status as of a scene, from its labelled steps (P2b-D22). */
function labelStatus(thread: string, atScene: string | null): ThreadStatus {
  const steps = TEST_BOOK_LABELS.threads.filter(
    (step) =>
      step.thread === thread &&
      (atScene === null || order(step.scene) <= order(atScene)) &&
      stepCounts({ voice: step.voice ?? 'narration', mode: step.mode ?? 'now' })
  )
  // The last counted step decides (P4): a thread advanced after it was resolved is open again.
  const last = steps.toSorted((a, b) => order(a.scene) - order(b.scene) || a.p - b.p).at(-1)
  if (last === undefined) return 'notYet'
  return last.how === 'resolves' ? 'resolved' : 'open'
}

/** A stored knows line, as the scorer reads it. */
interface StoredLine {
  claim: Claim
  learner: string | null
  secret: string | null
  scene: string
  line: ReturnType<typeof knowsLine>
}

const storedLines = (
  book: TestBookProject,
  topics: ReadonlyMap<string, string | null>
): StoredLine[] => {
  const labels = labelsOf(book)
  return liveSlot(book, 'knows').map((claim) => ({
    claim,
    learner: claim.recordId === null ? null : (labels.get(claim.recordId) ?? null),
    secret: claim.objectId === null ? null : (topics.get(claim.objectId) ?? null),
    scene: sceneOf(book, claim.nodeId),
    line: knowsLine(claim)
  }))
}

/** A stored line on a knows label's sentence: same scene, learner and secret, quotes overlapping. */
const onLabel = (stored: StoredLine, label: KnowsLabel): boolean =>
  stored.scene === label.scene &&
  stored.learner === label.learner &&
  stored.secret === label.secret &&
  overlaps(stored.claim.quote, label.quote)

/** What a pass scored (the replays assert it perfect; the live run holds it to the bars). */
export interface KnowsScore {
  /** Labelled learning and holding lines found live and counted. */
  knows: { labels: number; found: number; missed: string[] }
  /** Labelled suspects and believes-otherwise lines found live and partial. */
  partial: { labels: number; found: number; missed: string[] }
  /**
   * Stored counted and partial lines (the grid's cells) whose learner, secret and how class a
   * label in that scene has, and whose source ("told by X"), when the line names one, that label
   * names too. Each wrong line is listed under what made it wrong.
   */
  attribution: {
    lines: number
    right: number
    /** Counted lines no label has (learner, secret, how class). */
    wrong: string[]
    /** Partial lines (suspects, believes otherwise) no label has: still cells in the grid. */
    wrongPartial: string[]
    /** Lines a label has, but with a source no label names (an invented "told by"). */
    wrongFrom: string[]
  }
  /** Of the labels found on their sentence: the how, and (where labelled) the source. */
  how: { matched: number; right: number }
  from: { matched: number; right: number }
  steps: { labels: number; found: number; missed: string[] }
  /** Each labelled thread's status at the book's end. */
  status: { threads: number; right: number; wrong: string[] }
  topics: {
    labelled: number
    found: number
    records: number
    /** Topic records per labelled topic found (1.0: each made once). */
    duplicateRate: number
    /** Topic records no label stands for, listed for the author to read. */
    extra: string[]
  }
  /** Counted or partial knows lines a negative forbids (a dream, town talk, Mr. Harrow). */
  negatives: string[]
  /** Reveals or lines from scenes never read (the Idea scene, the cut one, the inactive draft). */
  neverRead: string[]
  /** The readings' rejections and counts, summed by reason. */
  yields: Record<string, number>
  readings: number
  cut: number
}

/** Scores one replayed or live-read book against the labels. */
export function scoreKnows(book: TestBookProject): KnowsScore {
  const topics = topicMap(book)
  const labels = labelsOf(book)
  const stored = storedLines(book, topics)
  const counted = stored.filter((each) => each.line === 'counts')
  // The grid's cells: counted and partial lines (rumour, dream and the like sit apart, uncounted).
  const cells = stored.filter((each) => each.line === 'counts' || each.line === 'partial')
  const describe = (label: KnowsLabel): string =>
    `${label.scene} ${label.learner} ${label.how} ${label.secret}`
  const said = (each: StoredLine): string =>
    `${each.scene} ${each.learner ?? '?'} ${each.claim.how ?? '?'} ${each.secret ?? '?'}${
      each.claim.fromId === null
        ? ''
        : ` from ${labels.get(each.claim.fromId) ?? each.claim.fromId}`
    } ← “${each.claim.quote}”`

  const holding = TEST_BOOK_LABELS.knows.filter((label) => !PARTIAL.includes(label.how))
  const missedKnows = holding.filter((label) => !counted.some((each) => onLabel(each, label)))
  const partialLabels = TEST_BOOK_LABELS.knows.filter((label) => PARTIAL.includes(label.how))
  const missedPartial = partialLabels.filter(
    (label) => !stored.some((each) => each.line === 'partial' && onLabel(each, label))
  )

  // A line's labels: the ones in its scene with its learner, secret and how class.
  const labelsFor = (each: StoredLine): KnowsLabel[] =>
    TEST_BOOK_LABELS.knows.filter(
      (label) =>
        label.scene === each.scene &&
        label.learner === each.learner &&
        label.secret === each.secret &&
        howClass(label.how) === howClass(each.claim.how)
    )
  const unlabelled = cells.filter((each) => labelsFor(each).length === 0)
  // A source the line names that none of its labels names (h13's regiment "told by" someone).
  const wrongFrom = cells.filter((each) => {
    const fromId = each.claim.fromId
    const own = labelsFor(each)
    return (
      fromId !== null &&
      own.length > 0 &&
      !own.some((label) => label.from !== null && labels.get(fromId) === label.from)
    )
  })
  const matched = TEST_BOOK_LABELS.knows.flatMap((label) => {
    const hit = stored.find((each) => onLabel(each, label))
    return hit === undefined ? [] : [{ label, hit }]
  })
  const withFrom = matched.filter(({ label }) => label.from !== null)

  const steps = liveSlot(book, 'thread')
  const missedSteps = TEST_BOOK_LABELS.threads.filter(
    (label) =>
      !steps.some(
        (claim) =>
          claim.recordId !== null &&
          topics.get(claim.recordId) === label.thread &&
          sceneOf(book, claim.nodeId) === label.scene &&
          claim.how === label.how &&
          overlaps(claim.quote, label.quote) &&
          stepCounts(claim) ===
            stepCounts({ voice: label.voice ?? 'narration', mode: label.mode ?? 'now' })
      )
  )

  const draftId = activeDraftId(book.db)
  const reading = readingOrder(book.db)
  const quotes = listTopicQuotes(book.db, draftId)
  const threadRecords = listTopics(book.db, 'thread')
  const views = threadsAsOf({
    threads: threadRecords.map((topic) => ({
      recordId: topic.recordId,
      label: topic.label,
      origin: topic.origin
    })),
    claims: steps,
    quotes,
    reading,
    atId: null
  })
  const labelThreads = TOPIC_LABELS.filter((topic) => topic.kind === 'thread')
  const statusWrong = labelThreads.flatMap((thread) => {
    const want = labelStatus(thread.id, null)
    const got = views.filter((view) => topics.get(view.recordId) === thread.id)
    if (got.length === 0) return [`${thread.id}: not made (expected ${want})`]
    return got
      .filter((view) => view.status !== want)
      .map((view) => `${thread.id}: ${view.status} (expected ${want})`)
  })

  const records = [...topics.values()]
  const found = new Set(records.filter((id): id is string => id !== null))
  const mappedRecords = records.filter((id) => id !== null).length
  const extra = [...topics]
    .filter(([, label]) => label === null)
    .map(([recordId]) => {
      const topic = listTopics(book.db).find((each) => each.recordId === recordId)
      const reveal = quotes.find((quote) => quote.recordId === recordId)
      return `${topic?.label ?? recordId} (${topic?.kind ?? '?'})${
        reveal === undefined ? '' : ` ← “${reveal.quote}” (${sceneOf(book, reveal.nodeId)})`
      }`
    })

  // Each cell a knows negative forbids, once (Mr. Harrow's h14 line falls under two).
  const negatives = cells
    .filter(
      (each) =>
        !TEST_BOOK_LABELS.knows.some((label) => onLabel(each, label)) &&
        TEST_BOOK_LABELS.negatives.some(
          (negative) =>
            negative.kind === 'knows' &&
            each.scene === negative.scene &&
            (negative.record === undefined || each.learner === negative.record) &&
            (negative.secret === undefined || each.secret === negative.secret)
        )
    )
    .map(said)

  const idea = book.scenes.get('h11')
  const cut = book.scenes.get('h12')
  const parked = [
    ...listTopicQuotes(book.db, book.inactiveDraftId),
    ...quotes.filter((quote) => quote.nodeId === idea || quote.nodeId === cut)
  ].map((quote) => `reveal “${quote.quote}”`)
  const strays = [
    ...parked,
    ...neverRead(book)
      .filter((claim) => claim.slot === 'knows' || claim.slot === 'thread')
      .map((claim) => `${claim.slot} “${claim.quote}”`)
  ]

  const yields: Record<string, number> = {}
  let readings = 0
  let cutReadings = 0
  for (const scene of TEST_BOOK) {
    if (scene.source !== 'scene') continue
    const last = lastReading(book.db, book.scenes.get(scene.id) ?? '', draftId)
    if (last === null) continue
    readings += 1
    if (last.finishReason === 'length') cutReadings += 1
    for (const [reason, count] of Object.entries(last.yields.rejections)) {
      yields[reason] = (yields[reason] ?? 0) + count
    }
  }

  return {
    knows: {
      labels: holding.length,
      found: holding.length - missedKnows.length,
      missed: missedKnows.map(describe)
    },
    partial: {
      labels: partialLabels.length,
      found: partialLabels.length - missedPartial.length,
      missed: missedPartial.map(describe)
    },
    attribution: {
      lines: cells.length,
      right: cells.length - unlabelled.length - wrongFrom.length,
      wrong: unlabelled.filter((each) => each.line === 'counts').map(said),
      wrongPartial: unlabelled.filter((each) => each.line === 'partial').map(said),
      wrongFrom: wrongFrom.map(said)
    },
    how: {
      matched: matched.length,
      right: matched.filter(({ label, hit }) => parseHow(hit.claim.how) === label.how).length
    },
    from: {
      matched: withFrom.length,
      right: withFrom.filter(
        ({ label, hit }) => hit.claim.fromId !== null && labels.get(hit.claim.fromId) === label.from
      ).length
    },
    steps: {
      labels: TEST_BOOK_LABELS.threads.length,
      found: TEST_BOOK_LABELS.threads.length - missedSteps.length,
      missed: missedSteps.map((step) => `${step.scene} ${step.thread} ${step.how}`)
    },
    status: {
      threads: labelThreads.length,
      right: labelThreads.length - statusWrong.length,
      wrong: statusWrong
    },
    topics: {
      labelled: TOPIC_LABELS.length,
      found: found.size,
      records: mappedRecords,
      duplicateRate: found.size === 0 ? 0 : mappedRecords / found.size,
      extra
    },
    negatives,
    neverRead: strays,
    yields,
    readings,
    cut: cutReadings
  }
}

/** Who knows what as of a scene over the stored book: the app's own view (`knowsViews.ts`). */
function storedKnows(book: TestBookProject, atScene: string | null): KnowsAsOf {
  const nodes = listNodes(book.db)
  return storedKnowsView(
    book.db,
    atScene === null ? null : (book.scenes.get(atScene) ?? null),
    readingOrder(book.db, nodes),
    nodes
  )
}

/** The grid's cells the labels give a secret as of a scene: counted first, then partial. */
function labelCells(secret: string, atScene: string): Map<string, string> {
  const lines = TEST_BOOK_LABELS.knows
    .filter((label) => label.secret === secret && order(label.scene) <= order(atScene))
    .sort((a, b) => order(a.scene) - order(b.scene) || a.p - b.p)
  const cells = new Map<string, string>()
  for (const partial of [false, true]) {
    for (const label of lines) {
      if (PARTIAL.includes(label.how) !== partial || cells.has(label.learner)) continue
      cells.set(label.learner, `${label.how} ${label.scene}`)
    }
  }
  return cells
}

/** The stored grid's cells for a labelled secret as of a scene (knower label → "how scene"). */
function gridCells(book: TestBookProject, secret: string, atScene: string): Map<string, string>[] {
  const topics = topicMap(book)
  const labels = labelsOf(book)
  return storedKnows(book, atScene)
    .secrets.filter((view) => topics.get(view.recordId) === secret)
    .map(
      (view) =>
        new Map(
          view.cells
            .filter((cell) => !cell.later)
            .map((cell) => [
              labels.get(cell.knowerId) ?? cell.knowerId,
              `${cell.how} ${cell.nodeId === null ? 'author' : sceneOf(book, cell.nodeId)}`
            ])
        )
    )
}

/** The scoped absence line and its scope: composed in the renderer only, never sent (P2b rule 9). */
const SCOPED = /no scene shows|checked up to/i
/** Words that would store someone's not knowing as a fact (P2b rule 9). */
const ABSENCE = /no scene shows|checked up to|does(?:n[’']t| not) know|never learn/i

/** A replayed book and the requests that read it. */
interface Replay {
  tmp: string
  book: TestBookProject
  ai: FakeAi
  outcomes: Map<string, string>
}

async function replay(
  name: string,
  readOrder: ReadOrder,
  reader: (request: CompletionRequest) => FakeAnswer = (request) => ({
    text: oracleRead(request)
  }),
  truth?: OracleTruth,
  before?: (book: TestBookProject) => void
): Promise<Replay> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mythscribe-knows-${name}-`))
  const book = buildTestBookProject(tmp, NOW)
  before?.(book)
  const ai = fakeAi(
    (request) =>
      requestKind(request) === 'verify' ? { text: oracleVerify(request, truth) } : reader(request),
    { now: NOW }
  )
  const outcomes = await readBook(book, ai.deps, { order: readOrder })
  return { tmp, book, ai, outcomes }
}

function close(run: Replay | undefined): void {
  if (run === undefined) return
  run.book.session.close()
  fs.rmSync(run.tmp, { recursive: true, force: true })
}

/** The topic record a labelled topic became (the one, when the replay made it once). */
const recordFor = (book: TestBookProject, topic: string): string[] =>
  [...topicMap(book)].filter(([, label]) => label === topic).map(([recordId]) => recordId)

for (const readOrder of ['book', 'reverse'] as const) {
  describe(`who knows what over the test book: the oracle replay in ${readOrder} order (F-16.22)`, () => {
    let run: Replay | undefined
    let score: KnowsScore

    beforeAll(async () => {
      run = await replay(readOrder, readOrder)
      score = scoreKnows(run.book)
    }, 60_000)
    afterAll(() => close(run))

    it('stores every labelled knows line as the labels give it, and nothing else counts', () => {
      expect(score.knows.missed).toEqual([])
      expect(score.partial.missed).toEqual([])
      expect(score.attribution).toMatchObject({ wrong: [], wrongPartial: [], wrongFrom: [] })
      expect(score.attribution.right).toBe(score.attribution.lines)
      expect(score.how.right).toBe(score.how.matched)
      expect(score.how.matched).toBe(TEST_BOOK_LABELS.knows.length)
      expect(score.from.right).toBe(score.from.matched)
      expect(score.negatives).toEqual([])
      expect(score.neverRead).toEqual([])
    })

    it('stores every thread step, and each thread ends as its labels say', () => {
      expect(score.steps.missed).toEqual([])
      expect(score.status.wrong).toEqual([])
    })

    it('makes each secret and thread once (duplicate rate 1.0), merging later reveals by Same', () => {
      expect(score.topics).toMatchObject({
        labelled: TOPIC_LABELS.length,
        found: TOPIC_LABELS.length,
        records: TOPIC_LABELS.length,
        duplicateRate: 1,
        extra: []
      })
      expect(listTopics(run?.book.db ?? fail()).every((topic) => topic.origin === 'ai')).toBe(true)
      // The defining reveals read after a topic was made merged into it through Same items.
      expect(score.yields.topicsCreated).toBe(TOPIC_LABELS.length)
      expect(score.yields.topicsMerged).toBe(readOrder === 'book' ? 2 : 3)
      expect(
        run?.ai.requests.some((request) =>
          /^\d+\. Same: /m.test(request.messages.at(-1)?.content ?? '')
        )
      ).toBe(true)
    })

    it('gives the grid as of h14 the labels’ cells, readers knowing each secret since its first scene', () => {
      const book = run?.book ?? fail()
      for (const secret of TOPIC_LABELS.filter((topic) => topic.kind === 'secret')) {
        expect(gridCells(book, secret.id, 'h14'), secret.id).toEqual([labelCells(secret.id, 'h14')])
        const first = TEST_BOOK_LABELS.knows
          .filter((label) => label.secret === secret.id && !PARTIAL.includes(label.how))
          .map((label) => label.scene)
          .sort((a, b) => order(a) - order(b))[0]
        const view = storedKnows(book, 'h14').secrets.find(
          (each) => each.recordId === recordFor(book, secret.id)[0]
        )
        // A secret nobody in the book learns (P4's, Check the book lists it): readers know it
        // from the scene that tells them.
        const since = first ?? secret.defining?.scene ?? ''
        expect(view?.readersSince?.nodeId, secret.id).toBe(book.scenes.get(since))
      }
      // As of h05 the engagement is known; the debts are not yet (learnt later).
      const early = storedKnows(book, 'h05')
      const debts = early.secrets.find(
        (each) => each.recordId === recordFor(book, 'secret-debts')[0]
      )
      expect([debts?.known, debts?.cells.every((cell) => cell.later)]).toEqual([false, true])
    })

    it('gives the story years and ages the labels give (decision 5)', () => {
      const book = run?.book ?? fail()
      // Read through the app's own views (timeViews.ts), as the Timeline and the sheets read them.
      // The planned card (h17, P4) has no words and no label: a plan, not a read scene.
      const planned = new Set(
        TEST_BOOK.filter((scene) => scene.source === 'plannedCard').map((scene) => scene.id)
      )
      const years = storedYears(book.db).filter((row) => !planned.has(sceneOf(book, row.nodeId)))
      expect(
        years.map((row) => {
          const scene = sceneOf(book, row.nodeId)
          return row.year.kind === 'unknown'
            ? [
                scene,
                'unknown',
                null,
                row.year.hint === null ? null : sceneOf(book, row.year.hint.nodeId)
              ]
            : [
                scene,
                row.year.kind,
                row.year.value,
                row.year.kind === 'carried' ? sceneOf(book, row.year.from.nodeId) : null
              ]
        })
      ).toEqual(
        TEST_BOOK_LABELS.years.map((label) => [
          label.scene,
          label.source,
          label.year,
          label.source === 'carried'
            ? (label.from ?? null)
            : label.source === 'unknown'
              ? (label.hint ?? null)
              : null
        ])
      )
      for (const label of TEST_BOOK_LABELS.ages) {
        const age = storedAge(
          book.db,
          book.records.get(label.record) ?? '',
          book.scenes.get(label.scene) ?? null
        )
        const at = `${label.record} as of ${label.scene}`
        const expected = label.expect
        if (expected.kind === 'stated') {
          const claim = TEST_BOOK_LABELS.claims.find((each) => each.id === expected.claim)
          const stored =
            claim === undefined
              ? undefined
              : storedFor(book, draftClaims(book.db, activeDraftId(book.db)), claim)
          expect(stored, at).toBeDefined()
          expect(age, at).toMatchObject({ kind: 'stated', claimId: stored?.id })
          expect(
            age?.kind === 'stated'
              ? [...new Set(age.since.map((entry) => sceneOf(book, sinceNodeId(entry))))]
              : null,
            at
          ).toEqual(expected.since)
        } else {
          expect(age, at).toMatchObject({ kind: 'computed', age: expected.age })
        }
      }
    })

    it.runIf(readOrder === 'book')(
      'scores a partial line on the wrong character and an invented source as wrong',
      () => {
        const book = run?.book ?? fail()
        const sqlite = book.session.connection.sqlite
        const lineOf = (learner: string, scene: string): Claim => {
          const found = liveSlot(book, 'knows').find(
            (claim) =>
              claim.recordId === book.records.get(learner) && sceneOf(book, claim.nodeId) === scene
          )
          return found ?? fail()
        }
        // Johanna's suspicion in h14 moved onto Mr. Harrow (a stored "believes otherwise"-style
        // cell the labels forbid), and the regiment "told by" Mrs. Pocock in h13 (no source given).
        const suspects = lineOf('johanna', 'h14')
        const regiment = lineOf('regiment', 'h13')
        sqlite.exec('SAVEPOINT knows_score_probe')
        try {
          sqlite
            .prepare('UPDATE claim SET record_id = ? WHERE id = ?')
            .run(book.records.get('harrow-mr'), suspects.id)
          sqlite
            .prepare('UPDATE claim SET from_id = ? WHERE id = ?')
            .run(book.records.get('pocock'), regiment.id)
          const probe = scoreKnows(book)
          expect(probe.attribution.wrong).toEqual([])
          expect(probe.attribution.wrongPartial).toEqual([
            expect.stringMatching(/^h14 harrow-mr suspects secret-debts ← /)
          ])
          expect(probe.attribution.wrongFrom).toEqual([
            expect.stringMatching(/^h13 regiment told secret-engagement from pocock ← /)
          ])
          expect(probe.attribution.right).toBe(probe.attribution.lines - 2)
          expect(probe.negatives).toEqual([
            expect.stringMatching(/^h14 harrow-mr suspects secret-debts/)
          ])
          expect(probe.partial.missed).toEqual(['h14 johanna suspects secret-debts'])
          const report = knowsReport(
            [
              {
                order: 'book',
                score: probe,
                costUsd: 0,
                requests: 0,
                stopped: false,
                error: null,
                costUnknown: null
              }
            ],
            { models: OPENROUTER_DEFAULT_MODELS, route: 'OpenRouter (test)', stopUsd: 0.5 }
          )
          expect(report.failures).toContain('book order: 1 negatives as grid cells')
          expect(report.markdown).toContain('Partial lines no label has')
          expect(report.markdown).toContain('Lines with a source no label names')
        } finally {
          sqlite.exec('ROLLBACK TO knows_score_probe; RELEASE knows_score_probe')
        }
        expect(scoreKnows(book).attribution).toMatchObject({ wrongPartial: [], wrongFrom: [] })
      }
    )

    it('keeps the invariants, reads nothing it may not, and never states an absence', () => {
      const book = run?.book ?? fail()
      expect(invariants(book)).toEqual([])
      for (const scene of TEST_BOOK) {
        if (scene.source === 'scene') expect(run?.outcomes.get(scene.id), scene.id).toBe('read')
      }
      for (const request of run?.ai.requests ?? []) {
        expect(JSON.stringify(request.messages)).not.toMatch(SCOPED)
        expect(request.reasoning).toBe('off')
      }
      const said = draftClaims(book.db, activeDraftId(book.db)).filter(
        (claim) => ABSENCE.test(claim.value) || ABSENCE.test(claim.how ?? '')
      )
      expect(said).toEqual([])
    })
  })
}

/** h06 ¶2, inside Lise's dream. */
const DREAM_QUOTE = 'Lottie was not there'
/** h07 ¶3, Lise passing on the town's talk. */
const TOWN_TALK_QUOTE = 'Mrs. Pocock had it from the curate’s wife'

/**
 * What the text shows for each adversarial plant that no label lists (the honest checker's answer
 * beside the labels): Lottie's letter says Bel knew all along, though Bel is not in h08; the town's
 * talk of the Captain's cards is his own secret, but only as rumour, and he is at the table; the
 * rumour in h07 and the dream in h06 reveal something only as rumour and dream, and what Lise is
 * passed off as told of the listed engagement there she has only in a dream and as town talk
 * (plan P2b §3.2); the new label for the engagement in h08 reveals it.
 */
const PLANT_TRUTH: OracleTruth = {
  knows: [
    {
      learner: 'liesel',
      secret: 'secret-engagement',
      quote: DREAM_QUOTE,
      how: 'told',
      from: null,
      voice: 'narration',
      mode: 'dream'
    },
    {
      learner: 'liesel',
      secret: 'secret-engagement',
      quote: TOWN_TALK_QUOTE,
      how: 'told',
      from: null,
      voice: 'rumour',
      mode: 'now'
    },
    {
      learner: 'bel',
      secret: 'secret-engagement',
      quote: 'Bel has known all along',
      how: 'knewBefore',
      from: null,
      voice: 'dialogue',
      mode: 'now'
    },
    {
      learner: 'captain',
      secret: 'secret-debts',
      quote: 'it was said that the Captain had lost an estate at cards in Elsdale',
      how: 'knewBefore',
      from: null,
      voice: 'rumour',
      mode: 'now'
    }
  ],
  reveals: [
    {
      label: "Varrow's spite",
      quote: 'They are saying in Callow Cross that Mr. Varrow refused a living',
      voice: 'rumour',
      mode: 'now'
    },
    {
      label: "Johanna's death",
      quote: 'In the dream, Johanna was dead',
      voice: 'narration',
      mode: 'dream'
    },
    {
      label: "Lottie's secret betrothal",
      quote: 'We are engaged, and have been since before Christmas',
      voice: 'dialogue',
      mode: 'now'
    }
  ],
  onPage: [
    {
      learner: 'captain',
      quote: 'it was said that the Captain had lost an estate at cards in Elsdale'
    }
  ]
}

/** The labels the adversarial reader plants as new secrets (none may become a record). */
const PLANTED_SECRETS = [
  "Varrow's spite",
  "Johanna's death",
  "Lottie's hasty marriage",
  'the muddy lane',
  'the head of the table',
  'the horses'
]

/** h09 ¶3, the sentence the author said reveals no secret (a Dismissed reveal). */
const DISMISSED_REVEAL = 'Lottie was eighteen now, and married'

/**
 * The adversarial reader: the oracle's answer plus, where their paragraphs are sent, a learner not
 * on the page, a rumour and a dream passed off as told of the listed engagement (and as new
 * secrets, told and saw), a rumoured line kept apart, a
 * group its sentence never names, a fourth new secret on one page, a duplicate of a listed secret
 * under a new label, a secret on a dismissed reveal, a step on a secret's id, and a line saying
 * Mr. Harrow does not know.
 */
function plantedRead(request: CompletionRequest): FakeAnswer {
  const answer = oracleAnswer(request)
  const scene = requestScene(request)?.id ?? ''
  const sent = sentParagraphs(request)
  const ids = rosterIds(request)
  const id = (record: string): string | null => {
    const name = TEST_BOOK_LABELS.records.find((each) => each.id === record)?.name ?? ''
    return ids.get(name) ?? null
  }
  /** A labelled topic's id here: this answer's, else the roster's. */
  const topic = (topicId: string): string | null => {
    const here = answer.topicRef.get(topicId)
    if (here !== undefined) return here
    for (const [label, short] of topicIds(request)) {
      if (topicByLabel(label) === topicId) return short
    }
    return null
  }
  const has = (p: number, quote: string): boolean =>
    (sent.get(p) ?? '').toLowerCase().includes(quote.toLowerCase())
  const line = (fields: Record<string, unknown>): void => {
    answer.c.push({ voice: 'narration', sp: null, mode: 'now', fr: null, ...fields })
  }
  const secret = (n: string, idOf: string, p: number, q: string): void => {
    answer.n.push({ n, kind: 'secret', id: idOf, p, q })
  }
  if (scene === 'h08' && has(3, 'Bel has known all along')) {
    // Bel is named, and Lottie's letter shows she knew; but Bel is not in this scene.
    const q = 'Bel has known all along'
    line({
      p: 3,
      r: id('bel'),
      s: 'knows',
      o: topic('secret-engagement'),
      how: 'knewBefore',
      v: 'knewBefore',
      q
    })
    // The engagement again, under a label of its own: the Same item merges it.
    secret(
      "Lottie's secret betrothal",
      'x91',
      3,
      'We are engaged, and have been since before Christmas'
    )
  }
  if (scene === 'h07' && has(3, TOWN_TALK_QUOTE)) {
    // The town's talk passed off as Lise being told of the listed engagement (plan P2b §3.2).
    line({
      p: 3,
      r: id('liesel'),
      s: 'knows',
      o: topic('secret-engagement'),
      how: 'told',
      v: 'told',
      q: TOWN_TALK_QUOTE
    })
  }
  if (scene === 'h06' && has(2, DREAM_QUOTE)) {
    // The dream passed off as Lise being told of the listed engagement (plan P2b §3.2).
    line({
      p: 2,
      r: id('liesel'),
      s: 'knows',
      o: topic('secret-engagement'),
      how: 'told',
      v: 'told',
      q: DREAM_QUOTE
    })
  }
  if (scene === 'h07' && has(3, 'out of spite')) {
    const q =
      'They are saying in Callow Cross that Mr. Varrow refused a living to Mr. Dunmore out of spite'
    secret("Varrow's spite", 'x92', 3, q)
    line({
      p: 3,
      r: id('liesel'),
      s: 'knows',
      o: 'x92',
      how: 'told',
      fr: id('pocock'),
      v: 'told',
      q
    })
  }
  if (scene === 'h06' && has(1, 'Johanna was dead')) {
    secret("Johanna's death", 'x93', 1, 'In the dream, Johanna was dead')
    line({
      p: 0,
      r: id('liesel'),
      s: 'knows',
      o: 'x93',
      how: 'saw',
      v: 'saw',
      q: 'That night Lise dreamed of the churchyard at Wexley'
    })
  }
  if (scene === 'h13' && has(3, 'told everybody she met')) {
    // "Everybody" is not the regiment: the group is not named here.
    line({
      p: 3,
      r: id('regiment'),
      s: 'knows',
      o: topic('secret-engagement'),
      how: 'told',
      v: 'told',
      q: 'the officer’s wife had told everybody she met'
    })
  }
  if (scene === 'h14' && has(9, 'lost an estate at cards')) {
    line({
      p: 9,
      r: id('captain'),
      s: 'knows',
      o: topic('secret-debts'),
      how: 'knewBefore',
      v: 'knewBefore',
      q: 'it was said that the Captain had lost an estate at cards in Elsdale'
    })
  }
  if (scene === 'h14' && has(4, 'noticed nothing at all')) {
    line({
      p: 4,
      r: id('harrow-mr'),
      s: 'knows',
      o: topic('secret-debts'),
      how: 'doesNotKnow',
      v: 'does not know',
      q: 'noticed nothing at all'
    })
  }
  if (scene === 'h14' && has(7, 'owed Mr. Varrow money')) {
    // Three more new secrets on the debts' page: the fourth is past the cap.
    secret('the muddy lane', 'x94', 1, 'The lane was deep in mud after the rain')
    secret('the head of the table', 'x95', 4, 'Mr. Harrow sat at the head of the table')
    secret('the horses', 'x96', 6, 'Bel talked to him about horses')
  }
  if (scene === 'h09' && has(3, DISMISSED_REVEAL)) {
    secret("Lottie's hasty marriage", 'x97', 3, DISMISSED_REVEAL)
    // A step on the engagement, a secret: not a thread's id.
    line({
      p: 3,
      r: topic('secret-engagement'),
      s: 'thread',
      how: 'resolves',
      v: 'Lottie is married',
      q: DISMISSED_REVEAL
    })
  }
  return { text: answerText(answer) }
}

/** Before reading: the author said h09's sentence of Lottie's marriage reveals no secret. */
function dismissMarriage(book: TestBookProject): void {
  const shared = nameScanShared(book.db)
  const sentence = TEST_BOOK.find((scene) => scene.id === 'h09')?.paragraphs[3] ?? ''
  dismiss(
    book.db,
    {
      kind: 'notRight',
      key: dismissedKey({
        kind: 'notRight',
        topic: { kind: 'secret', stating: [gateText(sentence, shared.index)] }
      }),
      recordId: null,
      label: "Lottie's hasty marriage is no secret",
      quote: DISMISSED_REVEAL
    },
    NOW
  )
}

describe('who knows what over the test book: the adversarial replay (F-16.22)', () => {
  let run: Replay | undefined
  let score: KnowsScore

  beforeAll(async () => {
    run = await replay('adversary', 'book', plantedRead, PLANT_TRUTH, dismissMarriage)
    score = scoreKnows(run.book)
  }, 60_000)
  afterAll(() => close(run))

  it('refuses a learner off the page, a group not named, a step on a secret, and a “does not know”', () => {
    const book = run?.book ?? fail()
    const labels = labelsOf(book)
    const lines = liveSlot(book, 'knows')
    const bel = book.records.get('bel')
    expect(
      lines.filter((claim) => claim.recordId === bel && sceneOf(book, claim.nodeId) === 'h08')
    ).toEqual([])
    expect(score.yields.notHere).toBeGreaterThanOrEqual(1)
    expect(score.yields.group).toBeGreaterThanOrEqual(1)
    expect(score.yields.record).toBeGreaterThanOrEqual(1)
    // Mr. Harrow notices nothing: no line about him in any state, and none says he does not know.
    const harrow = book.records.get('harrow-mr')
    expect(
      draftClaims(book.db, activeDraftId(book.db)).filter(
        (claim) => claim.recordId === harrow && claim.slot === 'knows'
      )
    ).toEqual([])
    expect(
      draftClaims(book.db, activeDraftId(book.db)).filter(
        (claim) => ABSENCE.test(claim.value) || ABSENCE.test(claim.how ?? '')
      )
    ).toEqual([])
    expect([...labels.values()]).toContain('harrow-mr')
  })

  it('makes no secret of a rumour, a dream, a dismissed reveal or the fourth on a page', () => {
    const book = run?.book ?? fail()
    const made = listTopics(book.db).map((topic) => normName(topic.label))
    for (const label of PLANTED_SECRETS) expect(made, label).not.toContain(normName(label))
    expect(score.yields.topicNotCounted).toBeGreaterThanOrEqual(2)
    expect(score.yields.topicCap).toBeGreaterThanOrEqual(1)
    // The dismissed reveal never reached the checker.
    const reveals = (run?.ai.requests ?? [])
      .filter((request) => requestKind(request) === 'verify')
      .flatMap((request) => request.messages.at(-1)?.content.split('\n') ?? [])
      .filter((text) => text.includes('Reveals:'))
    expect(reveals.some((text) => text.includes('hasty marriage'))).toBe(false)
    expect(reveals.some((text) => text.includes('the horses'))).toBe(false)
  })

  it('stores the dream and the town talk passed off as told with their mode and voice, uncounted', () => {
    const book = run?.book ?? fail()
    const liesel = book.records.get('liesel')
    const engagement = recordFor(book, 'secret-engagement')[0]
    const planted = liveSlot(book, 'knows').filter(
      (claim) =>
        claim.recordId === liesel &&
        claim.objectId === engagement &&
        ['h06', 'h07'].includes(sceneOf(book, claim.nodeId))
    )
    expect(
      planted
        .map((claim) => [sceneOf(book, claim.nodeId), claim.voice, claim.mode, knowsLine(claim)])
        .sort()
    ).toEqual([
      ['h06', 'narration', 'dream', 'other'],
      ['h07', 'rumour', 'now', 'other']
    ])
    // Lise's cell is still her own overhearing in h05; the dream and the talk sit apart.
    const view = storedKnows(book, 'h14').secrets.find((each) => each.recordId === engagement)
    expect(
      view?.cells.filter((cell) => cell.knowerId === liesel).map((cell) => cell.nodeId)
    ).toEqual([book.scenes.get('h05')])
    expect(
      view?.others
        .filter((cell) => cell.knowerId === liesel)
        .map((cell) => sceneOf(book, cell.nodeId ?? ''))
        .sort()
    ).toEqual(['h06', 'h07'])
    // Neither is a negative: nothing in h06 or h07 counts.
    expect(score.negatives).toEqual([])
  })

  it('merges the duplicate under its new label, and keeps the rumoured line apart, uncounted', () => {
    const book = run?.book ?? fail()
    const engagement = recordFor(book, 'secret-engagement')
    expect(engagement).toHaveLength(1)
    const merged = listTopicQuotes(book.db, activeDraftId(book.db)).filter(
      (quote) => quote.recordId === engagement[0] && quote.role === 'merged'
    )
    expect(merged.map((quote) => quote.label)).toContain("Lottie's secret betrothal")
    const captain = book.records.get('captain')
    const rumour = liveSlot(book, 'knows').filter((claim) => claim.recordId === captain)
    expect(rumour.map((claim) => [claim.voice, knowsLine(claim)])).toEqual([['rumour', 'other']])
    const debts = storedKnows(book, 'h14').secrets.find(
      (view) => view.recordId === recordFor(book, 'secret-debts')[0]
    )
    expect(debts?.cells.some((cell) => cell.knowerId === captain)).toBe(false)
    expect(debts?.others.map((cell) => cell.knowerId)).toEqual([captain])
  })

  it('leaves the counted picture exactly the labels’ (nothing planted counts)', () => {
    const book = run?.book ?? fail()
    expect(score.knows.missed).toEqual([])
    expect(score.partial.missed).toEqual([])
    expect(score.attribution).toMatchObject({ wrong: [], wrongPartial: [], wrongFrom: [] })
    expect(score.negatives).toEqual([])
    expect(score.steps.missed).toEqual([])
    expect(score.status.wrong).toEqual([])
    expect(score.topics).toMatchObject({ duplicateRate: 1, extra: [] })
    for (const secret of TOPIC_LABELS.filter((topic) => topic.kind === 'secret')) {
      expect(gridCells(book, secret.id, 'h14'), secret.id).toEqual([labelCells(secret.id, 'h14')])
    }
    expect(invariants(book)).toEqual([])
  })
})

/** One live pass: its order, its score, what it cost, and whether the cost cap stopped it. */
export interface KnowsPass {
  order: ReadOrder
  score: KnowsScore
  costUsd: number
  requests: number
  /** The 50¢ stop came before the book's last scene. */
  stopped: boolean
  /** The provider error that stopped the pass (where, and after how many scenes), or null. */
  error: string | null
  /** Why the 50¢ stop could not hold (`LiveRequestDeps.costUnknown`), or null. */
  costUnknown: string | null
}

export interface KnowsLiveReport {
  markdown: string
  json: unknown
  failures: string[]
  passes: KnowsPass[]
}

/**
 * The live knows run (plan P2b §3.3): two passes on fresh copies of the test book, in book order
 * and then in reverse order (late creation and merges), with the real `reader.v2` and `verify.v2`
 * through `live`; reading stops once the reported cost passes `stopUsd` (both passes together),
 * once a cost cannot be known (nothing more is read), or, for that pass, at a provider error (a
 * 429, a 402, a 5xx). The report is written either way, with what was read and what it cost.
 */
export async function runLiveKnows(
  live: LiveProvider,
  options: { stopUsd?: number; now?: Date } = {}
): Promise<KnowsLiveReport> {
  const stopUsd = options.stopUsd ?? LIVE_STOP_USD
  const scenes = TEST_BOOK.filter((scene) => scene.source !== 'inactiveDraft').length
  const passes: KnowsPass[] = []
  let spentBefore = 0
  let unknownBefore: string | null = null
  for (const readOrder of ['book', 'reverse'] as const) {
    const run = liveRequestDeps(live)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mythscribe-knows-live-${readOrder}-`))
    const book = buildTestBookProject(tmp, options.now ?? new Date())
    try {
      const over = (): boolean => spentBefore + run.spent() > stopUsd
      const outcomes = await readBook(book, run.deps, {
        order: readOrder,
        stopAt: () => over() || unknownBefore !== null || run.costUnknown() !== null,
        providerErrors: 'stop'
      })
      const costUnknown: string | null = unknownBefore ?? run.costUnknown()
      passes.push({
        order: readOrder,
        score: scoreKnows(book),
        costUsd: run.spent(),
        requests: run.ledger.length,
        stopped: outcomes.size < scenes && over(),
        error: readingStop(outcomes),
        costUnknown
      })
      spentBefore += run.spent()
      unknownBefore = costUnknown
    } finally {
      book.session.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  return knowsReport(passes, { models: live.models, route: live.describe, stopUsd })
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${part}/${whole} (${((part / whole) * 100).toFixed(1)} %)`

const listed = (title: string, lines: readonly string[]): string[] => [
  `**${title}:** ${lines.length === 0 ? 'none.' : ''}`,
  ...lines.map((line) => `- ${line}`),
  ''
]

/** The live run's report: per pass against the bars (P2b-D23), then what to read by hand. */
export function knowsReport(
  passes: readonly KnowsPass[],
  run: { models: Record<Tier, string>; route: string; stopUsd: number; at?: Date }
): KnowsLiveReport {
  const bars = KNOWS_PASS_BARS
  const failures: string[] = []
  for (const pass of passes) {
    const { score } = pass
    const bar = (name: string, part: number, whole: number, min: number): void => {
      if (whole > 0 && part / whole < min) {
        failures.push(`${pass.order} order: ${name} ${percent(part, whole)} < ${min * 100} %`)
      }
    }
    bar('knows recall', score.knows.found, score.knows.labels, bars.knowsRecall)
    bar(
      'attribution precision',
      score.attribution.right,
      score.attribution.lines,
      bars.attributionPrecision
    )
    bar('how accuracy', score.how.right, score.how.matched, bars.howAccuracy)
    bar('from accuracy', score.from.right, score.from.matched, bars.fromAccuracy)
    if (score.topics.duplicateRate > bars.duplicateRate) {
      failures.push(
        `${pass.order} order: duplicate rate ${score.topics.duplicateRate.toFixed(2)} > ${bars.duplicateRate}`
      )
    }
    if (score.negatives.length > 0) {
      failures.push(`${pass.order} order: ${score.negatives.length} negatives as grid cells`)
    }
    if (score.neverRead.length > 0) {
      failures.push(`${pass.order} order: ${score.neverRead.length} from never-read scenes`)
    }
    if (pass.stopped) {
      failures.push(`${pass.order} order: stopped at the ${run.stopUsd} USD cap before the end`)
    }
    if (pass.error !== null) {
      failures.push(`${pass.order} order: stopped by a provider error (${pass.error})`)
    }
    if (pass.costUnknown !== null) failures.push(`${pass.order} order: ${pass.costUnknown}`)
  }
  const cost = passes.reduce((sum, pass) => sum + pass.costUsd, 0)
  const requests = passes.reduce((sum, pass) => sum + pass.requests, 0)
  const column = (pick: (pass: KnowsPass) => string): string =>
    passes.map((pass) => pick(pass)).join(' | ')
  const header = passes.map((pass) => `${pass.order === 'book' ? 'Book' : 'Reverse'} order`)
  const row = (name: string, pick: (pass: KnowsPass) => string, bar: string): string =>
    `| ${name} | ${column(pick)} | ${bar} |`
  const lines = [
    `# Story memory: the live knows run (${(run.at ?? new Date()).toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`, on ${run.route}. ` +
      `Requests: ${requests}; reported cost: ${cost.toFixed(4)} USD (it stops at ${run.stopUsd} USD).`,
    '',
    '## Pass bars (decided by Claude, unconfirmed; P2b-D23)',
    '',
    `| Measure | ${header.join(' | ')} | Bar |`,
    `| --- | ${header.map(() => '---').join(' | ')} | --- |`,
    row(
      'Knows recall (learning and holding lines)',
      (pass) => percent(pass.score.knows.found, pass.score.knows.labels),
      `≥ ${bars.knowsRecall * 100} %`
    ),
    row(
      'Partial lines found (suspects, believes otherwise)',
      (pass) => percent(pass.score.partial.found, pass.score.partial.labels),
      'no bar'
    ),
    row(
      'Attribution precision (counted and partial lines a label has, with its source)',
      (pass) => percent(pass.score.attribution.right, pass.score.attribution.lines),
      `≥ ${bars.attributionPrecision * 100} %`
    ),
    row(
      'How accuracy',
      (pass) => percent(pass.score.how.right, pass.score.how.matched),
      `≥ ${bars.howAccuracy * 100} %`
    ),
    row(
      'From accuracy',
      (pass) => percent(pass.score.from.right, pass.score.from.matched),
      `≥ ${bars.fromAccuracy * 100} %`
    ),
    row(
      'Thread steps found',
      (pass) => percent(pass.score.steps.found, pass.score.steps.labels),
      'no bar'
    ),
    row(
      'Thread status at the end',
      (pass) => percent(pass.score.status.right, pass.score.status.threads),
      'no bar'
    ),
    row(
      'Duplicate rate (topic records per labelled topic)',
      (pass) =>
        `${pass.score.topics.duplicateRate.toFixed(2)} (${pass.score.topics.records} for ${pass.score.topics.found} of ${pass.score.topics.labelled})`,
      `≤ ${bars.duplicateRate}`
    ),
    row('Extra topics (no label)', (pass) => String(pass.score.topics.extra.length), 'read each'),
    row(
      'Negatives as grid cells (counted or partial)',
      (pass) => String(pass.score.negatives.length),
      '0'
    ),
    row('From never-read scenes', (pass) => String(pass.score.neverRead.length), '0'),
    row(
      'Cut off at the cap and not recovered by the re-read',
      (pass) => `${pass.score.cut} of ${pass.score.readings} readings`,
      'no bar'
    ),
    row('Cost (USD)', (pass) => pass.costUsd.toFixed(4), `stops at ${run.stopUsd}`),
    row('Stopped by a provider error', (pass) => pass.error ?? 'no', 'no'),
    '',
    failures.length === 0 ? '**Passed.**' : `**Failed:** ${failures.join('; ')}.`,
    ''
  ]
  for (const pass of passes) {
    const { score } = pass
    lines.push(
      `## ${pass.order === 'book' ? 'Book' : 'Reverse'} order`,
      '',
      ...listed('Knows lines missed', score.knows.missed),
      ...listed('Partial lines missed', score.partial.missed),
      ...(pass.error === null ? [] : [`**Stopped by a provider error:** ${pass.error}.`, '']),
      ...(pass.costUnknown === null ? [] : [`**Cost unknown:** ${pass.costUnknown}.`, '']),
      ...listed('Counted lines no label has (attribution)', score.attribution.wrong),
      ...listed(
        'Partial lines no label has (attribution; still cells in the grid)',
        score.attribution.wrongPartial
      ),
      ...listed('Lines with a source no label names (attribution)', score.attribution.wrongFrom),
      ...listed('Extra topics (read each against its sentence)', score.topics.extra),
      ...listed('Negatives as grid cells (counted or partial)', score.negatives),
      ...listed('From never-read scenes', score.neverRead),
      ...listed('Thread steps missed', score.steps.missed),
      ...listed('Thread status not as labelled', score.status.wrong),
      `**Yields by reason:** ${
        Object.entries(score.yields)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([reason, count]) => `${reason} ${count}`)
          .join(', ') || 'none'
      }.`,
      ''
    )
  }
  lines.push('No prompt text and no key are written here.')
  return {
    markdown: lines.join('\n'),
    json: {
      models: run.models,
      route: run.route,
      costUsd: cost,
      requests,
      bars,
      passes,
      failures
    },
    failures,
    passes: [...passes]
  }
}

describe('the live knows run, end to end against a fake OpenRouter (F-16.22; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone, sends as the app does, and passes every bar', async () => {
    const server = oracleChatServer()
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLiveKnows(live, { now: NOW })
    expect(report.failures).toEqual([])
    expect(report.passes.map((pass) => [pass.order, pass.score.topics.duplicateRate])).toEqual([
      ['book', 1],
      ['reverse', 1]
    ])
    expect(server.calls.length).toBeGreaterThan(0)
    for (const call of server.calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      expect(call.body).toMatchObject({ reasoning: { enabled: false }, usage: { include: true } })
    }
    // Everything on V4 Flash but the checker's open-ended facts (plan ReaderPrecision.md: the
    // strong batch of history, traits, relation, kinship and role), which go to V4 Pro.
    const strong = server.calls.filter(
      (call) => call.body.model === OPENROUTER_DEFAULT_MODELS.strong
    )
    expect(strong.length).toBeGreaterThan(0)
    for (const call of strong) {
      expect(JSON.stringify(call.body.messages)).toContain(VERIFY_SENTINEL)
    }
    expect(
      server.calls.every(
        (call) =>
          call.body.model === OPENROUTER_DEFAULT_MODELS.fast ||
          call.body.model === OPENROUTER_DEFAULT_MODELS.strong
      )
    ).toBe(true)
    // The reported cost is what the run counts (0.0001 USD a request at the fake).
    const cost = report.passes.reduce((sum, pass) => sum + pass.costUsd, 0)
    expect(cost).toBeCloseTo(server.calls.length * 0.0001, 6)
    expect(report.markdown).toContain('**Passed.**')
    expect(report.markdown).toContain('on OpenRouter (OPENROUTER_API_KEY)')
    expect(report.markdown).not.toContain('sk-or-fake')
    expect(report.markdown).not.toContain('You are the story-memory reader')
    expect(JSON.stringify(report.json)).not.toContain('sk-or-fake')
  }, 120_000)

  it('stops once the reported cost passes the cap, and says so', async () => {
    const server = fakeChatServer((messages) => ({
      text:
        requestKind({ messages }) === 'verify'
          ? oracleVerify({ messages })
          : oracleRead({ messages }),
      costUsd: 0.3
    }))
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLiveKnows(live, { now: NOW })
    expect(report.passes.map((pass) => pass.stopped)).toEqual([true, true])
    // The scene that passed 50¢ finishes; nothing more is asked.
    expect(report.passes.reduce((sum, pass) => sum + pass.costUsd, 0)).toBeLessThan(2)
    expect(report.passes[1]?.requests).toBe(0)
    expect(report.failures.some((failure) => failure.includes('stopped at the 0.5 USD cap'))).toBe(
      true
    )
  }, 120_000)
})

describe('the live knows run stops and still reports (F-16.22; nothing spent)', () => {
  it('stops a pass at a provider error and reports what it read and what it cost', async () => {
    const server = fakeChatServer((messages) =>
      server.calls.length > 6
        ? { text: 'Rate limit exceeded', status: 429 }
        : {
            text:
              requestKind({ messages }) === 'verify'
                ? oracleVerify({ messages })
                : oracleRead({ messages })
          }
    )
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLiveKnows(live, { now: NOW })
    expect(report.passes.map((pass) => pass.error)).toEqual([
      expect.stringMatching(/^\w+: RATE_LIMIT: .* after \d+ scenes read$/),
      expect.stringMatching(/^h16: RATE_LIMIT: .* after 0 scenes read$/)
    ])
    expect(report.passes.map((pass) => pass.stopped)).toEqual([false, false])
    // The six answered requests were paid for: the report counts them.
    expect(report.passes.reduce((sum, pass) => sum + pass.costUsd, 0)).toBeCloseTo(0.0006, 6)
    expect(report.failures).toContain(
      `book order: stopped by a provider error (${report.passes[0]?.error ?? ''})`
    )
    expect(report.markdown).toContain(`**Stopped by a provider error:** ${report.passes[0]?.error}`)
    expect(report.markdown).not.toContain('sk-or-fake')
  }, 120_000)

  it('stops when a cost cannot be known, and says why', async () => {
    const server = fakeChatServer((messages) => ({
      text:
        requestKind({ messages }) === 'verify'
          ? oracleVerify({ messages })
          : oracleRead({ messages }),
      costUsd: null
    }))
    const live = liveProviderFromEnv(
      { OPENROUTER_API_KEY: 'sk-or-fake', MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/unlisted-model' },
      { fetch: server.fetch }
    )
    const report = await runLiveKnows(live, { now: NOW })
    // One scene is read before the stop can see it; the second pass reads nothing.
    expect(report.passes[0]?.requests).toBeGreaterThan(0)
    expect(report.passes[1]?.requests).toBe(0)
    expect(report.passes.map((pass) => pass.costUnknown)).toEqual([
      expect.stringMatching(/^cost unknown for vendor\/unlisted-model/),
      expect.stringMatching(/^cost unknown for vendor\/unlisted-model/)
    ])
    expect(report.failures.some((failure) => failure.includes('cost unknown'))).toBe(true)
    expect(report.markdown).toContain('**Cost unknown:**')
  }, 120_000)
})

describe.skipIf(!LIVE)('the live knows run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('reads the test book twice with the real reader and checker, scores who knows what, and writes the report', async () => {
    const report = await runLiveKnows(liveProviderFromEnv())
    const dir = path.resolve('test-results/eval-knows')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(path.join(dir, `knows-${stamp}.md`), report.markdown)
    fs.writeFileSync(path.join(dir, `knows-${stamp}.json`), JSON.stringify(report.json, null, 2))
    process.stdout.write(`\n${report.markdown}\n`)
    expect(report.failures).toEqual([])
  }, 1_800_000)
})
