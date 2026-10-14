import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS, type Tier } from '@shared/ai'
import { valueKey, type Claim } from '@shared/memory/claims'
import { normalizeForMatch } from '@shared/critique'
import { parseVerifyAnswer, type VerifyVerdict } from '@shared/memory/readerAnswer'
import { SPOT_STRONG_AROUND } from '@shared/memory/spot'
import { dismissedNames, rosterOf } from '../../memory/recordStore'
import { twinGate } from '@shared/memory/twinGate'
import { buildVerifyV2Prompt } from '../prompts/verify.v2'
import type { CompletionRequest } from '../providers/types'
import { runAiRequest, sha256 } from '../request'
import { activeDraftId } from '../../draft/draftStore'
import {
  agrees,
  claimCheck,
  type ClaimCheck,
  type ReadingItemEvent
} from '../../memory/reading/pipeline'
import { loadReadingScene, readBook as readerBook } from '../../memory/reading/readerContext'
import { topicItemLines } from '../../memory/reading/topicContext'
import { readerRoster } from '../../memory/reading/rosterCache'
import { lastReading } from '../../memory/reading/readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentChecks,
  sentParagraphs,
  type FakeAi,
  type FakeAnswer
} from '../../memory/reading/readingFixture'
import { TEST_BOOK } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import { buildTestBookProject, type TestBookProject } from '../../memory/testBook/project'
import { plantedBarLines, plantedFailures, plantedMeasures, unreviewedLines } from './plantedScore'
import { fakeChatServer } from './fakeChatServer'
import {
  liveProviderError,
  liveProviderFromEnv,
  liveRequestDeps,
  type LiveProvider
} from './liveProvider'
import {
  answerText,
  invariants,
  liveClaims,
  liveFacts,
  nameOf,
  negativesStored,
  neverRead,
  oracleAnswer,
  oracleChatServer,
  oracleRead,
  oracleVerify,
  overlaps,
  proposal,
  readBook,
  readingStop,
  sceneOf,
  sentLabels,
  slotOf,
  storedFor,
  wantsCard,
  oracleCard,
  type ClaimLabel
} from './memoryOracle'

/**
 * Story memory's reading pipeline over the test book (F-16.17; plan P2a §2.7), `npm run eval:ai`
 * (and so `npm run test`):
 *
 * - The **oracle replay**: a provider that reads exactly what the labels say (their rejected facts
 *   included) and checks every item by its label's `expect` (`memoryOracle.ts`, shared with the
 *   knows replays of `knows.eval.ts`, which score its knows lines, steps and topics). Every
 *   `literal` label must be stored literal, every `verified` one verified, no `reject` label and
 *   no negative may be stored live, nothing may come from the Idea scene, the scene left out of
 *   compile or the inactive draft, and the memory invariants must hold.
 * - The **adversarial replay**: the same honest checker behind a reader that plants errors (a quote
 *   not in the text, one in another paragraph, a repeated one, the pronoun trap answered as one
 *   woman, a negation as a literal fact, the dream death as now, the lie as narration, a value with
 *   words not in the quote, a reply cut off at its cap). None may reach a live narration claim, and
 *   the reading's yields count each by its reason.
 * - The **live planted-error run** (`MYTHSCRIBE_EVAL_LIVE=1`, the merge condition of P2a, design
 *   §2.3 point 4; owed by the author before the switch-over): the same pipeline with the real
 *   provider over every readable scene, then the spot checks, scored per slot with pass bars, and a
 *   report under `test-results/eval-memory/`. One command, one key (`liveProvider.ts`):
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- memory
 *
 *   (`OPENAI_API_KEY` still works, with `OPENAI_BASE_URL` for OpenRouter or another server.)
 *   Models: `MYTHSCRIBE_EVAL_FAST_MODEL` / `MYTHSCRIBE_EVAL_STRONG_MODEL`, else the OpenRouter
 *   defaults (V4 Flash, V4 Pro) on OpenRouter and `DEFAULT_MODELS` elsewhere. It stops reading once
 *   the reported cost passes 50¢ (about 5¢ expected on V4 Flash and Pro).
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

/** Three words that stand twice in the paragraphs sent, with the paragraph of the first. */
function repeatedTrigram(request: CompletionRequest): { p: number; q: string } | null {
  const sent = sentParagraphs(request)
  const all = [...sent.values()].map((text) => normalizeForMatch(text)).join(' ')
  for (const [p, text] of sent) {
    const words = normalizeForMatch(text).split(' ')
    for (let i = 0; i + 3 <= words.length; i += 1) {
      const q = words.slice(i, i + 3).join(' ')
      if (!/^[\p{L} ]+$/u.test(q)) continue
      const hits = all.split(q).length - 1
      if (hits >= 2) return { p, q }
    }
  }
  return null
}

const label = (id: string): ClaimLabel => {
  const found = TEST_BOOK_LABELS.claims.find((claim) => claim.id === id)
  if (found === undefined) throw new Error(`No label ${id}`)
  return found
}

/**
 * The adversarial reader: the labels' facts plus planted errors where their scenes are sent, and
 * the first page of s01 cut off at its cap (the retry is answered whole).
 */
function adversarialRead(request: CompletionRequest, state: { cut: boolean }): FakeAnswer {
  const ids = rosterIds(request)
  const sent = sentLabels(request)
  const has = (id: string): boolean => sent.some((claim) => claim.id === id)
  const planted: Record<string, unknown>[] = []
  if (has('varrow-eyes-grey')) {
    const grey = proposal(label('varrow-eyes-grey'), ids)
    planted.push({ ...grey, q: "Mr. Varrow's eyes were a warm blue" })
    planted.push({ ...grey, p: 5 })
    planted.push({ ...grey, v: 'blue' })
  }
  if (has('green-eyes-trap')) planted.push(proposal(label('green-eyes-trap'), ids))
  if (has('captain-not-blue')) planted.push(proposal(label('captain-not-blue'), ids))
  if (has('johanna-dream')) {
    planted.push({ ...proposal(label('johanna-dream'), ids), v: 'no', mode: 'now' })
  }
  if (has('dunmore-clergyman')) {
    planted.push({ ...proposal(label('dunmore-clergyman'), ids), voice: 'narration', sp: null })
  }
  const twice = repeatedTrigram(request)
  const anyone = ids.values().next().value
  if (twice !== null && anyone !== undefined) {
    planted.push({
      p: twice.p,
      r: anyone,
      s: 'traits',
      v: twice.q,
      q: twice.q,
      voice: 'narration',
      mode: 'now'
    })
  }
  const text = JSON.stringify({
    c: [...sent.map((claim) => proposal(claim, ids)), ...planted],
    n: [],
    ...(wantsCard(request) ? { card: oracleCard(request) } : {})
  })
  if (!state.cut && sent.some((claim) => claim.scene === 's01')) {
    state.cut = true
    return { text: text.slice(0, Math.floor(text.length / 2)), finishReason: 'length' }
  }
  return { text }
}

describe('the reading pipeline over the test book: the oracle replay (F-16.17)', () => {
  let tmp: string
  let book: TestBookProject
  let ai: FakeAi
  let outcomes: Map<string, string>

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-oracle-'))
    book = buildTestBookProject(tmp, NOW)
    ai = fakeAi((request) => ({
      text: requestKind(request) === 'verify' ? oracleVerify(request) : oracleRead(request)
    }))
    outcomes = await readBook(book, ai.deps)
  }, 60_000)
  afterAll(() => {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reads every readable scene and never the Idea scene or the one left out of compile', () => {
    for (const scene of TEST_BOOK) {
      if (scene.source === 'scene') expect(outcomes.get(scene.id), scene.id).toBe('read')
    }
    expect(outcomes.get('h11')).toBe('notReadable')
    expect(outcomes.get('h12')).toBe('notReadable')
    expect(neverRead(book)).toEqual([])
  })

  it('stores every literal label literal and every verified one verified, as labelled', () => {
    const claims = liveFacts(book)
    for (const wanted of TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'reject')) {
      const stored = storedFor(book, claims, wanted)
      expect(stored, wanted.id).toBeDefined()
      expect(stored?.proof, wanted.id).toBe(wanted.expect)
      expect([stored?.voice, stored?.mode], wanted.id).toEqual([wanted.voice, wanted.mode])
    }
  })

  it('stores exactly those: no reject label and no negative is live, and nothing else', () => {
    const claims = liveFacts(book)
    for (const wanted of TEST_BOOK_LABELS.claims.filter((claim) => claim.expect === 'reject')) {
      expect(storedFor(book, claims, wanted), wanted.id).toBeUndefined()
    }
    expect(negativesStored(book, claims)).toEqual([])
    const labelled = TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'reject')
    expect(claims).toHaveLength(labelled.length)
  })

  it('keeps the memory invariants and the readings’ yields', () => {
    expect(invariants(book)).toEqual([])
    const s03 = lastReading(book.db, book.scenes.get('s03') ?? '', activeDraftId(book.db))
    expect(s03?.yields.items).toBeGreaterThan(0)
    expect(s03?.yields.quotesFound).toBe(s03?.yields.items)
    expect(ai.requests.every((request) => request.reasoning === 'off')).toBe(true)
  })
})

describe('the reading pipeline over the test book: the adversarial replay (F-16.17)', () => {
  let tmp: string
  let book: TestBookProject
  const rejections: Record<string, number> = {}
  let cut = 0

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-adversary-'))
    book = buildTestBookProject(tmp, NOW)
    const state = { cut: false }
    const ai = fakeAi((request) =>
      requestKind(request) === 'verify'
        ? { text: oracleVerify(request) }
        : adversarialRead(request, state)
    )
    await readBook(book, ai.deps)
    for (const scene of TEST_BOOK) {
      const reading = lastReading(book.db, book.scenes.get(scene.id) ?? '', activeDraftId(book.db))
      if (reading === null || scene.source !== 'scene') continue
      cut += reading.yields.cut
      for (const [reason, count] of Object.entries(reading.yields.rejections)) {
        rejections[reason] = (rejections[reason] ?? 0) + count
      }
    }
  }, 60_000)
  afterAll(() => {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('lets no planted error reach a live narration claim', () => {
    const labelled = TEST_BOOK_LABELS.claims.filter(
      (claim) => claim.expect !== 'reject' && claim.voice === 'narration' && claim.mode === 'now'
    )
    const strays = liveFacts(book).filter(
      (claim) =>
        claim.voice === 'narration' &&
        claim.mode === 'now' &&
        !labelled.some(
          (wanted) =>
            book.records.get(wanted.record) === claim.recordId &&
            wanted.slot === claim.slot &&
            overlaps(wanted.quote, claim.quote) &&
            valueKey(wanted.value) === claim.valueKey
        )
    )
    expect(strays.map((claim) => `${claim.slot} “${claim.value}” ← ${claim.quote}`)).toEqual([])
    expect(negativesStored(book, liveFacts(book))).toEqual([])
    expect(neverRead(book)).toEqual([])
    expect(invariants(book)).toEqual([])
  })

  it('counts each planted error by its reason', () => {
    expect(rejections.notFound).toBeGreaterThanOrEqual(1)
    expect(rejections.otherParagraph).toBeGreaterThanOrEqual(1)
    expect(rejections.repeated).toBeGreaterThanOrEqual(1)
    // The negation, the dream death as "no", the wrong eye colour: refused by the checker.
    expect(rejections.unsupported).toBeGreaterThanOrEqual(3)
    expect(cut).toBe(1)
  })

  it('keeps the honest facts beside the planted ones, the lie stored as his own words', () => {
    const claims = liveFacts(book)
    const lie = storedFor(book, claims, label('dunmore-clergyman'))
    expect([lie?.voice, lie?.mode]).toEqual(['dialogue', 'now'])
    expect(storedFor(book, claims, label('varrow-eyes-grey'))?.proof).toBe('literal')
    // The pronoun trap answered as one woman waits on both; nobody's eyes are green.
    expect(storedFor(book, claims, label('green-eyes-trap'))).toBeUndefined()
  })
})

/**
 * One failure of the live planted-error run of 2026-10-14
 * (`test-results/eval-memory/planted-2026-10-14.md`), as the reader proposed it, and the code gate
 * that now refuses it whatever the checker answers.
 */
interface LivePlant {
  scene: string
  p: number
  record: string
  slot: string
  value: string
  quote: string
  voice?: 'dialogue'
  /** The speaker's record label, for dialogue. */
  speaker?: string
  refused: 'subject' | 'value' | 'wish' | 'kind' | 'slot'
}

const LIVE_PLANTS: readonly LivePlant[] = [
  // The shared surname: the checker picked Mr. Harrow, and "Harrow's temper" was stored.
  {
    scene: 'h03',
    p: 1,
    record: 'harrow-mr',
    slot: 'traits',
    value: 'short tempered',
    quote: 'Harrow’s temper was short that morning',
    refused: 'subject'
  },
  // Both sisters walk: one of them is never the fact's subject.
  {
    scene: 'h07',
    p: 0,
    record: 'johanna',
    slot: 'location',
    value: 'Callow Cross',
    quote: 'the sisters walked to Callow Cross',
    refused: 'subject'
  },
  {
    scene: 'h07',
    p: 0,
    record: 'johanna',
    slot: 'objects',
    value: 'thread',
    quote: 'Johanna wanted thread',
    refused: 'wish'
  },
  {
    scene: 'h07',
    p: 1,
    record: 'johanna',
    slot: 'location',
    value: 'the road',
    quote: 'Johanna walked quickly',
    refused: 'value'
  },
  {
    scene: 'h07',
    p: 1,
    record: 'johanna',
    slot: 'traits',
    value: 'talked of everything except Thornmere',
    quote: 'talked of everything except Thornmere',
    refused: 'subject'
  },
  {
    scene: 'h03',
    p: 5,
    record: 'harrow-mrs',
    slot: 'detail:accent',
    value: 'unfeeling',
    quote: 'How can you be so unfeeling',
    voice: 'dialogue',
    speaker: 'harrow-mrs',
    refused: 'subject'
  },
  {
    scene: 'h09',
    p: 0,
    record: 'thornmere',
    slot: 'detail:home',
    value: 'Thornmere',
    quote: 'Lise came back to Thornmere',
    refused: 'kind'
  },
  {
    scene: 's02',
    p: 1,
    record: 'harrow-mr',
    slot: 'detail:occupation',
    value: 'hope Mr. Ashby will like it',
    quote: 'I hope Mr. Ashby will like it, Lise.',
    voice: 'dialogue',
    speaker: 'harrow-mr',
    refused: 'wish'
  },
  {
    scene: 'h03',
    p: 8,
    record: 'harrow-mr',
    slot: 'location',
    value: 'at the table',
    quote: 'Mr. Harrow said nothing more until the cloth was drawn',
    refused: 'value'
  },
  // An invented slot.
  {
    scene: 'h07',
    p: 1,
    record: 'johanna',
    slot: 'emotion',
    value: 'quickly',
    quote: 'Johanna walked quickly',
    refused: 'slot'
  }
]

/**
 * True facts the live run proposed, kept: h09's "Lise came back to Thornmere" (a sentence the
 * earlier draft h10 shares, which the scorer once counted as a never-read claim), and a detail
 * label written bare ("birthplace"), read as its slot.
 */
const LIVE_KEPT: readonly Omit<LivePlant, 'refused'>[] = [
  {
    scene: 'h09',
    p: 0,
    record: 'liesel',
    slot: 'location',
    value: 'Thornmere',
    quote: 'Lise came back to Thornmere'
  },
  {
    scene: 'h15',
    p:
      TEST_BOOK.find((scene) => scene.id === 'h15')?.paragraphs.findIndex((text) =>
        text.includes('Miss Fenwick was born at Gullhaven')
      ) ?? -1,
    record: 'anne',
    slot: 'birthplace',
    value: 'Gullhaven',
    quote: 'Miss Fenwick was born at Gullhaven'
  }
]

/** The plants a reader request sent the paragraph of, in the reader's short-key form. */
function plantsFor(
  request: CompletionRequest,
  plants: readonly Omit<LivePlant, 'refused'>[]
): Record<string, unknown>[] {
  const ids = rosterIds(request)
  const sent = sentParagraphs(request)
  const id = (record: string): string | null => ids.get(nameOf.get(record) ?? '') ?? null
  return plants
    .filter((plant) => {
      const text = sent.get(plant.p)
      return text !== undefined && normalizeForMatch(text).includes(normalizeForMatch(plant.quote))
    })
    .map((plant) => ({
      p: plant.p,
      r: id(plant.record),
      s: plant.slot,
      v: plant.value,
      q: plant.quote,
      ...(plant.voice === undefined
        ? {}
        : { voice: plant.voice, sp: plant.speaker === undefined ? null : id(plant.speaker) })
    }))
}

/**
 * A gullible checker: every fact item whose sentences hold a plant's quote is supported, about the
 * plant's record, with the voice and mode the fact line gives; every other item as the oracle.
 * Only the code gates stand between a plant and the memory.
 */
function gullibleVerify(request: CompletionRequest): string {
  const honest = JSON.parse(oracleVerify(request)) as { v: { i: number }[] }
  const plants = [...LIVE_PLANTS, ...LIVE_KEPT]
  const verdicts = sentChecks(request).map((check) => {
    const plant = plants.find(
      (each) =>
        check.kind === 'claim' &&
        normalizeForMatch(check.text).includes(normalizeForMatch(each.quote))
    )
    if (plant === undefined) return honest.v.find((verdict) => verdict.i === check.i) ?? null
    const said = /\((narration|dialogue|thought|rumour)(?: by \S+)?, (\w+)\)$/.exec(check.fact)
    const at = check.names.indexOf(nameOf.get(plant.record) ?? '')
    return {
      i: check.i,
      ok: true,
      r: check.who[at] ?? check.who[0] ?? null,
      voice: said?.[1] ?? 'narration',
      mode: said?.[2] ?? 'now'
    }
  })
  return JSON.stringify({ v: verdicts.filter((verdict) => verdict !== null) })
}

describe('the live run’s failures of 2026-10-14, planted (F-16.17)', () => {
  let tmp: string
  let book: TestBookProject
  const events: { event: ReadingItemEvent; scene: string }[] = []

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-live-plants-'))
    book = buildTestBookProject(tmp, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: gullibleVerify(request) }
      const answer = oracleAnswer(request)
      return {
        text: answerText({
          ...answer,
          c: [...answer.c, ...plantsFor(request, [...LIVE_PLANTS, ...LIVE_KEPT])]
        })
      }
    })
    await readBook(book, ai.deps, { observe: (event, scene) => events.push({ event, scene }) })
  }, 60_000)
  afterAll(() => {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('refuses each failure in code, before any checker could support it', () => {
    for (const plant of LIVE_PLANTS) {
      const ended = events.filter(
        ({ event, scene }) =>
          scene === plant.scene &&
          event.slot === plant.slot &&
          normalizeForMatch(event.quote) === normalizeForMatch(plant.quote)
      )
      // (h03's temper is also the oracle's own reject label, refused the same way.)
      expect(ended.length, `${plant.scene} ${plant.slot} “${plant.value}”`).toBeGreaterThan(0)
      expect(
        [...new Set(ended.map(({ event }) => event.outcome))],
        `${plant.scene} ${plant.slot} “${plant.value}”`
      ).toEqual([plant.refused])
    }
    const live = liveFacts(book)
    for (const plant of LIVE_PLANTS) {
      const stored = live.filter(
        (claim) =>
          sceneOf(book, claim.nodeId) === plant.scene &&
          claim.recordId === book.records.get(plant.record) &&
          overlaps(claim.quote, plant.quote) &&
          valueKey(claim.value) === valueKey(plant.value)
      )
      expect(stored, `${plant.scene} ${plant.slot} “${plant.value}”`).toEqual([])
    }
  })

  it('stores no negative and nothing from a never-read scene, and keeps the true facts', () => {
    const live = liveFacts(book)
    expect(negativesStored(book, live)).toEqual([])
    expect(neverRead(book)).toEqual([])
    for (const kept of LIVE_KEPT) {
      expect(
        live.some(
          (claim) =>
            sceneOf(book, claim.nodeId) === kept.scene &&
            claim.recordId === book.records.get(kept.record) &&
            overlaps(claim.quote, kept.quote)
        ),
        `${kept.scene} ${kept.slot}`
      ).toBe(true)
    }
    // The bare label was read as its slot.
    expect(
      live.some(
        (claim) => claim.slot === 'detail:birthplace' && claim.recordId === book.records.get('anne')
      )
    ).toBe(true)
    // The honest labels are all stored as labelled beside the plants.
    for (const wanted of TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'reject')) {
      expect(storedFor(book, live, wanted), wanted.id).toBeDefined()
    }
    expect(invariants(book)).toEqual([])
  })
})

/** One line of the live report's per-slot table. */
interface SlotScore {
  proposed: number
  quoteFound: number
  literal: number
  verified: number
  waiting: number
  rejected: Record<string, number>
  labels: number
  recalled: number
}

const PRESENCE = new Set([
  'tooShort',
  'tooLong',
  'notFound',
  'otherParagraph',
  'repeated',
  'slot',
  'record'
])

/** The live run stops reading once its reported cost passes this. */
const LIVE_STOP_USD = 0.5

/**
 * The live planted-error run (P2a §2.7) through `live`: every readable scene with the real reader
 * and checker, then the spot checks, scored per slot; answers the report. Every request leaves as
 * the app sends it (the reader and the checker with no reasoning).
 */
export async function runLivePlanted(
  live: LiveProvider
): Promise<{ markdown: string; json: unknown; failures: string[] }> {
  const { models, openRouter } = live
  const { deps: ai, ledger, spent, costUnknown } = liveRequestDeps(live)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-live-'))
  const book = buildTestBookProject(tmp, NOW)
  try {
    const events: (ReadingItemEvent & { scene: string })[] = []
    // A provider error (a 429, a 402, a 5xx) stops the run, which still reports what it read
    // and what it cost; so does a cost the 50¢ stop cannot see.
    const outcomes = await readBook(book, ai, {
      observe: (event, scene) => events.push({ ...event, scene }),
      stopAt: () => spent() > LIVE_STOP_USD || costUnknown() !== null,
      providerErrors: 'stop'
    })
    let error = readingStop(outcomes)

    // The spot checks: up to 50 literal claims on the fast tier (batches of 10), up to 20
    // verified ones on the strong tier, one per call with three sentences either side. Each is
    // built and scored as the app's spot checks do (`claimCheck`, `agrees`): a knows line as a
    // knows item with its secret and sources, a thread step as a step item, the how agreed too.
    const claims = liveClaims(book)
    const roster = readerRoster(book.db)
    const topicLines = topicItemLines(book.db, roster, activeDraftId(book.db))
    const readable = readerBook(book.db)
    const check = (claim: Claim, around: number): { claim: Claim; check: ClaimCheck } | null => {
      const scene = loadReadingScene(book.db, claim.nodeId, readable)
      const built = scene === null ? null : claimCheck(scene, claim, roster, around, topicLines)
      return built === null ? null : { claim, check: built }
    }
    const agreed = (
      entry: { claim: Claim; check: ClaimCheck },
      verdict: VerifyVerdict | undefined
    ): boolean =>
      verdict !== undefined &&
      agrees(verdict, {
        expect: entry.check.expect,
        voice: entry.claim.voice,
        mode: entry.claim.mode,
        how: entry.check.how
      })
    const spot = { fastAgree: 0, fastChecked: 0, strongAgree: 0, strongChecked: 0 }
    // The 50¢ stop holds through the spot checks too: checked before every request.
    let stopped = spent() > LIVE_STOP_USD
    const over = (): boolean => {
      stopped ||= spent() > LIVE_STOP_USD
      return stopped || error !== null || costUnknown() !== null
    }
    /** One spot check's answer, or null once a provider error stopped the run (recorded). */
    const ask = async (input: Parameters<typeof runAiRequest>[1]): Promise<string | null> => {
      try {
        return (await runAiRequest(ai, input)).text
      } catch (err) {
        const said = liveProviderError(err)
        if (said === null) throw err
        error = `spot checks: ${said}`
        return null
      }
    }
    if (!over()) {
      const literal = claims
        .filter((claim) => claim.proof === 'literal')
        .flatMap((claim) => check(claim, 1) ?? [])
        .slice(0, 50)
      const batches: (typeof literal)[] = []
      for (let i = 0; i < literal.length; i += 10) batches.push(literal.slice(i, i + 10))
      for (const batch of batches) {
        if (over()) break
        const prompt = buildVerifyV2Prompt({ items: batch.map((entry) => entry.check) })
        const text = await ask({
          feature: 'verify',
          tier: 'fast',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: prompt.version
        })
        if (text === null) break
        const verdicts = parseVerifyAnswer(text)
        spot.fastChecked += batch.length
        spot.fastAgree += batch.filter((entry, i) => agreed(entry, verdicts.get(i + 1))).length
      }
      const strong = claims
        .filter((each) => each.proof === 'verified')
        .flatMap((claim) => check(claim, SPOT_STRONG_AROUND) ?? [])
        .slice(0, 20)
      for (const entry of strong) {
        if (over()) break
        const prompt = buildVerifyV2Prompt({ items: [entry.check], strong: true })
        const text = await ask({
          feature: 'verify',
          tier: 'strong',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: prompt.version
        })
        if (text === null) break
        spot.strongChecked += 1
        if (agreed(entry, parseVerifyAnswer(text).get(1))) spot.strongAgree += 1
      }
    }

    return scoreLive(book, events, outcomes, spot, {
      models,
      costUsd: spent(),
      stopped,
      error,
      costUnknown: costUnknown(),
      requests: ledger.length,
      openRouter,
      route: live.describe
    })
  } finally {
    book.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

describe('the live planted-error run, end to end against a fake OpenRouter (F-16.22; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone, sends as the app does, and scores the book', async () => {
    const server = oracleChatServer()
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLivePlanted(live)
    expect(report.failures).toEqual([])
    expect(report.markdown).toContain('on OpenRouter (OPENROUTER_API_KEY)')
    expect(report.markdown).not.toContain('sk-or-fake')
    expect(server.calls.length).toBeGreaterThan(0)
    for (const call of server.calls) {
      expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      expect(call.body).toMatchObject({ reasoning: { enabled: false }, usage: { include: true } })
    }
    // The strong spot checks go to V4 Pro, everything else to V4 Flash.
    expect(new Set(server.calls.map((call) => call.body.model))).toEqual(
      new Set([OPENROUTER_DEFAULT_MODELS.fast, OPENROUTER_DEFAULT_MODELS.strong])
    )
  }, 120_000)

  it('stops at a provider error and still reports what it read and what it cost', async () => {
    const server = fakeChatServer((messages) =>
      server.calls.length > 4
        ? { text: 'Payment required', status: 402 }
        : {
            text:
              requestKind({ messages }) === 'verify'
                ? oracleVerify({ messages })
                : oracleRead({ messages })
          }
    )
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake' }, { fetch: server.fetch })
    const report = await runLivePlanted(live)
    expect(report.failures).toContainEqual(
      expect.stringMatching(
        /^stopped by a provider error \(\w+: [A-Z_]+: .* after \d+ scenes read\)$/
      )
    )
    expect(report.markdown).toContain('**Stopped by a provider error:**')
    expect(report.markdown).toContain('reported cost: 0.0004 USD')
    // Nothing more was asked after the error: no spot check.
    expect(server.calls).toHaveLength(5)
  }, 120_000)
})

describe.skipIf(!LIVE)('the live planted-error run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('reads the test book with the real provider, scores it per slot, and writes the report', async () => {
    // One key (F-16.22): OPENROUTER_API_KEY, else OPENAI_API_KEY (and OPENAI_BASE_URL).
    const report = await runLivePlanted(liveProviderFromEnv())
    const dir = path.resolve('test-results/eval-memory')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(path.join(dir, `planted-${stamp}.md`), report.markdown)
    fs.writeFileSync(path.join(dir, `planted-${stamp}.json`), JSON.stringify(report.json, null, 2))
    process.stdout.write(`\n${report.markdown}\n`)
    expect(report.failures).toEqual([])
  }, 900_000)
})

const percent = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)} %`

/** Scores the live run per slot against the labels; answers the report and the failed bars. */
function scoreLive(
  book: TestBookProject,
  events: readonly (ReadingItemEvent & { scene: string })[],
  outcomes: ReadonlyMap<string, string>,
  spot: { fastAgree: number; fastChecked: number; strongAgree: number; strongChecked: number },
  run: {
    models: Record<Tier, string>
    costUsd: number
    stopped: boolean
    /** The provider error that stopped the run (where, and after how many scenes), or null. */
    error: string | null
    /** Why the 50¢ stop could not hold (`LiveRequestDeps.costUnknown`), or null. */
    costUnknown: string | null
    requests: number
    openRouter: boolean
    /** The route and the key's variable (`LiveProvider.describe`), never the key. */
    route: string
  }
): { markdown: string; json: unknown; failures: string[] } {
  const claims = liveFacts(book)
  const wanted = TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'reject')
  const slots = new Map<string, SlotScore>()
  const score = (slot: string): SlotScore => {
    const found = slots.get(slot) ?? {
      proposed: 0,
      quoteFound: 0,
      literal: 0,
      verified: 0,
      waiting: 0,
      rejected: {},
      labels: 0,
      recalled: 0
    }
    slots.set(slot, found)
    return found
  }
  for (const event of events) {
    const entry = score(event.slot)
    entry.proposed += 1
    if (!PRESENCE.has(event.outcome)) entry.quoteFound += 1
    if (event.outcome === 'literal') entry.literal += 1
    else if (event.outcome === 'verified') entry.verified += 1
    else if (event.outcome === 'waiting') entry.waiting += 1
    else entry.rejected[event.outcome] = (entry.rejected[event.outcome] ?? 0) + 1
  }
  for (const label of wanted) {
    const entry = score(slotOf(label))
    entry.labels += 1
    if (storedFor(book, claims, label) !== undefined) entry.recalled += 1
  }

  // The bars' measures (`plantedScore.ts`, shared with the switch-over run).
  const measures = plantedMeasures(book)

  // Names: proposed, and those the twin gate ties to a record (a twin it caught).
  const names = [...new Set(events.flatMap((event) => (event.name === null ? [] : [event.name])))]
  const roster = rosterOf(book.db)
  const dismissed = dismissedNames(book.db)
  const twins = names.filter((name) => twinGate(name, roster, dismissed).outcome === 'blocked')
  const readCount = [...outcomes.values()].filter((outcome) => outcome === 'read').length

  const failures = plantedFailures(measures)
  if (run.error !== null) failures.push(`stopped by a provider error (${run.error})`)
  if (run.costUnknown !== null) failures.push(run.costUnknown)

  const lines = [
    `# Story memory: the live planted-error run (${new Date().toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`, on ${run.route}. ` +
      `Scenes read: ${readCount}; requests: ${run.requests}; reported cost: ${run.costUsd.toFixed(4)} USD` +
      `${run.stopped ? ` (stopped at the ${LIVE_STOP_USD} USD cap)` : ''}.`,
    ...(run.error === null ? [] : ['', `**Stopped by a provider error:** ${run.error}.`]),
    ...(run.costUnknown === null ? [] : ['', `**Cost unknown:** ${run.costUnknown}.`]),
    '',
    '## Pass bars (decided by Claude, unconfirmed)',
    '',
    ...plantedBarLines(measures),
    `- Cut off at the cap (finish_reason length): ${percent(measures.cut.right, readCount)} of readings`,
    `- Names proposed: ${names.length}; tied to a record by the twin gate: ${twins.length}${twins.length > 0 ? ` (${twins.join(', ')})` : ''}`,
    `- Spot checks: fast ${spot.fastAgree} of ${spot.fastChecked} agree; strong ${spot.strongAgree} of ${spot.strongChecked} agree`,
    '',
    failures.length === 0 ? '**Passed.**' : `**Failed:** ${failures.join('; ')}.`,
    '',
    '## Per slot',
    '',
    '| Slot | Proposed | Quote found | Literal | Verified | Waiting | Rejected (by reason) | Recall (labels) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...slots]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([slot, entry]) =>
          `| ${slot} | ${entry.proposed} | ${entry.quoteFound} | ${entry.literal} | ${entry.verified} | ${entry.waiting} | ${
            Object.entries(entry.rejected)
              .map(([reason, count]) => `${reason} ${count}`)
              .join(', ') || '-'
          } | ${entry.recalled}/${entry.labels} |`
      ),
    '',
    ...unreviewedLines(measures),
    '',
    'Recall has no bar: sheets may be thinner than the labels. No prompt text and no key are written here.'
  ]
  return {
    markdown: lines.join('\n'),
    json: {
      models: run.models,
      costUsd: run.costUsd,
      stopped: run.stopped,
      error: run.error,
      costUnknown: run.costUnknown,
      requests: run.requests,
      scenesRead: readCount,
      quotesFound: { found: measures.quotesFound.right, proposed: measures.quotesFound.of },
      verifierPass: { passed: measures.verifierPass.right, sent: measures.verifierPass.of },
      attribution: { right: measures.attribution.right, matched: measures.attribution.of },
      literalPrecision: {
        right: measures.literalPrecision.right,
        literal: measures.literalPrecision.of
      },
      supportPrecision: {
        right: measures.supportPrecision.right,
        matched: measures.supportPrecision.of
      },
      unreviewed: measures.unreviewed,
      neverRead: measures.strays,
      falseAlarms: measures.falseAlarms,
      cutReadings: measures.cut.right,
      names: { proposed: names.length, twins },
      spot,
      slots: Object.fromEntries(slots),
      failures
    },
    failures
  }
}
