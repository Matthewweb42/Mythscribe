import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, OPENROUTER_DEFAULT_MODELS, priceFor, type Tier } from '@shared/ai'
import { autoTable, defaultAiRouting } from '@shared/aiRouting'
import { sceneSentences } from '@shared/memory/anchor'
import { setsState, valueKey, type Claim } from '@shared/memory/claims'
import { normalizeForMatch } from '@shared/critique'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { containsValue } from '@shared/memory/reconcile'
import { dismissedNames, rosterOf } from '../../memory/recordStore'
import { twinGate } from '@shared/memory/twinGate'
import type { CachedResponse } from '../cacheStore'
import { dayOf, defaultAiUsageState } from '../dailyCap'
import { buildVerifyV2Prompt, type VerifyV2Item } from '../prompts/verify.v2'
import { buildOpenAiProvider } from '../providers/openai'
import type { CompletionRequest } from '../providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../request'
import type { UsageEntry } from '../usageStore'
import { activeDraftId } from '../../draft/draftStore'
import { draftClaims, invariantClaims } from '../../memory/reading/claimStore'
import { runReading, type ReadingItemEvent } from '../../memory/reading/pipeline'
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
import { sceneTexts } from '../../memory/reading/claimFixture'
import { TEST_BOOK } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import { buildTestBookProject, type TestBookProject } from '../../memory/testBook/project'

/**
 * Story memory's reading pipeline over the test book (F-16.17; plan P2a §2.7), `npm run eval:ai`
 * (and so `npm run test`):
 *
 * - The **oracle replay**: a provider that reads exactly what the labels say (their rejected facts
 *   included) and checks every item by its label's `expect`. Every `literal` label must be stored
 *   literal, every `verified` one verified, no `reject` label and no negative may be stored live,
 *   nothing may come from the Idea scene, the scene left out of compile or the inactive draft, and
 *   the memory invariants must hold.
 * - The **adversarial replay**: the same honest checker behind a reader that plants errors (a quote
 *   not in the text, one in another paragraph, a repeated one, the pronoun trap answered as one
 *   woman, a negation as a literal fact, the dream death as now, the lie as narration, a value with
 *   words not in the quote, a reply cut off at its cap). None may reach a live narration claim, and
 *   the reading's yields count each by its reason.
 * - The **live planted-error run** (`MYTHSCRIBE_EVAL_LIVE=1`, the merge condition of P2a, design
 *   §2.3 point 4; owed by the author before the switch-over): the same pipeline with the real
 *   provider over every readable scene, then the spot checks, scored per slot with pass bars, and a
 *   report under `test-results/eval-memory/`. One command:
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENAI_API_KEY=sk-or-… OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
 *         npm run eval:ai -- memory
 *
 *   Models: `MYTHSCRIBE_EVAL_FAST_MODEL` / `MYTHSCRIBE_EVAL_STRONG_MODEL`, else the OpenRouter
 *   defaults (V4 Flash, V4 Pro) on OpenRouter and `DEFAULT_MODELS` elsewhere. It stops reading once
 *   the reported cost passes 50¢ (about 5¢ expected on V4 Flash and Pro).
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

type Label = (typeof TEST_BOOK_LABELS.claims)[number]

const nameOf = new Map(TEST_BOOK_LABELS.records.map((record) => [record.id, record.name]))

/** A label's slot as the pipeline stores it (`relation:<record>` is `relation` with an object). */
const slotOf = (label: { slot: string }): string =>
  label.slot.startsWith('relation:') ? 'relation' : label.slot

/** Whether two quotes overlap once normalised (one holds the other). */
function overlaps(a: string, b: string): boolean {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  return x.includes(y) || y.includes(x)
}

/** A label as the reader would propose it, ids the request's roster ids. */
function proposal(label: Label, ids: ReadonlyMap<string, string>): Record<string, unknown> {
  const relation = label.slot.startsWith('relation:')
  return {
    p: label.p,
    r: ids.get(nameOf.get(label.record) ?? '') ?? null,
    s: relation ? 'relation' : label.slot,
    v: label.value,
    q: label.quote,
    voice: label.voice,
    sp: label.speaker === undefined ? null : (ids.get(nameOf.get(label.speaker) ?? '') ?? null),
    mode: label.mode,
    o: relation ? (ids.get(nameOf.get(label.slot.slice('relation:'.length)) ?? '') ?? null) : null,
    chg: false
  }
}

/** The labels whose quote the request sent, in the paragraph they name. */
function sentLabels(request: CompletionRequest): Label[] {
  const sent = sentParagraphs(request)
  return TEST_BOOK_LABELS.claims.filter((label) => {
    const text = sent.get(label.p)
    return text !== undefined && normalizeForMatch(text).includes(normalizeForMatch(label.quote))
  })
}

const CARD = {
  line: 'A scene of the test book.',
  gist: 'A scene of the test book, read by the oracle.',
  where: null,
  when: null,
  year: null,
  elapsed: null,
  pov: null,
  flash: null,
  present: [],
  mood: null,
  theme: null
}

const wantsCard = (request: CompletionRequest): boolean =>
  request.messages.at(-1)?.content.endsWith('Card: yes') === true

/** The honest checker: each item by its label (quote, slot and value), else not supported. */
function oracleVerify(request: CompletionRequest): string {
  const verdicts = sentChecks(request).map((check) => {
    if (check.label !== 'Fact') return { i: check.i, ok: false }
    const fact = /^(\S+): (.*?)(?: \(of [rn]\d+\))? \([a-z]+(?: by [rn]\d+)?, [a-z]+\)$/.exec(
      check.fact
    )
    const slot = fact?.[1] ?? ''
    const value = fact?.[2] ?? ''
    const label = TEST_BOOK_LABELS.claims.find(
      (candidate) =>
        slotOf(candidate) === slot &&
        normalizeForMatch(check.text).includes(normalizeForMatch(candidate.quote).slice(0, 40)) &&
        (containsValue(valueKey(candidate.value), valueKey(value)) ||
          containsValue(valueKey(value), valueKey(candidate.value)))
    )
    if (label === undefined) return { i: check.i, ok: false }
    if (label.expect === 'reject') {
      // A pronoun more than one person fits: supported, but nobody in particular.
      return check.who.length > 1
        ? { i: check.i, ok: true, r: null, voice: label.voice, mode: label.mode }
        : { i: check.i, ok: false }
    }
    const at = check.names.indexOf(nameOf.get(label.record) ?? '')
    return {
      i: check.i,
      ok: true,
      r: at === -1 ? null : (check.who[at] ?? null),
      voice: label.voice,
      mode: label.mode
    }
  })
  return JSON.stringify({ v: verdicts })
}

/** The oracle reader: exactly the labels' facts for the paragraphs sent. */
function oracleRead(request: CompletionRequest): string {
  const ids = rosterIds(request)
  return JSON.stringify({
    c: sentLabels(request).map((label) => proposal(label, ids)),
    n: [],
    same: [],
    drop: [],
    ...(wantsCard(request) ? { card: CARD } : {})
  })
}

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

const label = (id: string): Label => {
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
    ...(wantsCard(request) ? { card: CARD } : {})
  })
  if (!state.cut && sent.some((claim) => claim.scene === 's01')) {
    state.cut = true
    return { text: text.slice(0, Math.floor(text.length / 2)), finishReason: 'length' }
  }
  return { text }
}

/** Reads every scene of the book (the inactive draft's h10 is h09's node: read once). */
async function readBook(
  book: TestBookProject,
  ai: AiRequestDeps,
  observe?: (event: ReadingItemEvent, sceneId: string) => void,
  stopAt?: () => boolean
): Promise<Map<string, string>> {
  const outcomes = new Map<string, string>()
  for (const scene of TEST_BOOK) {
    if (scene.source === 'inactiveDraft') continue
    if (stopAt?.() === true) break
    const nodeId = book.scenes.get(scene.id) ?? ''
    const outcome = await runReading(
      book.db,
      { ai },
      {
        nodeId,
        caretPara: null,
        requestId: `eval-${scene.id}`,
        ...(observe === undefined
          ? {}
          : { observe: (event: ReadingItemEvent) => observe(event, scene.id) })
      }
    )
    outcomes.set(scene.id, outcome.read ? 'read' : outcome.reason)
  }
  return outcomes
}

const liveClaims = (book: TestBookProject): Claim[] =>
  draftClaims(book.db, activeDraftId(book.db)).filter((claim) => claim.state === 'live')

const sceneOf = (book: TestBookProject, nodeId: string): string =>
  [...book.scenes].find(([id, node]) => node === nodeId && id !== 'h10')?.[0] ?? ''

/** The stored claim a label names (by scene, record, slot and quote), when there is one. */
function storedFor(
  book: TestBookProject,
  claims: readonly Claim[],
  wanted: Label
): Claim | undefined {
  const recordId = book.records.get(wanted.record)
  return claims.find(
    (claim) =>
      sceneOf(book, claim.nodeId) === wanted.scene &&
      claim.recordId === recordId &&
      claim.slot === slotOf(wanted) &&
      overlaps(claim.quote, wanted.quote)
  )
}

function invariants(book: TestBookProject): ReturnType<typeof checkMemoryInvariants> {
  const scenes = new Map(
    [...new Set(book.scenes.values())].map((node) => [
      node,
      new Set(sceneSentences(sceneTexts(book.db, node)).map((sentence) => sentence.hash))
    ])
  )
  return checkMemoryInvariants({
    claims: invariantClaims(book.db),
    sceneHashes: scenes,
    aliases: [],
    citations: []
  })
}

/** Nothing from the scenes that are never read: the Idea scene, the cut scene, the inactive draft. */
function neverRead(book: TestBookProject): Claim[] {
  const idea = book.scenes.get('h11')
  const cut = book.scenes.get('h12')
  const earlier = TEST_BOOK.find((scene) => scene.id === 'h10')?.paragraphs ?? []
  const all = [
    ...draftClaims(book.db, activeDraftId(book.db)),
    ...draftClaims(book.db, book.inactiveDraftId)
  ]
  return all.filter(
    (claim) =>
      claim.nodeId === idea ||
      claim.nodeId === cut ||
      claim.draftId === book.inactiveDraftId ||
      earlier.some((paragraph) =>
        normalizeForMatch(paragraph).includes(normalizeForMatch(claim.quote))
      )
  )
}

/**
 * Negatives stored live: a claim or a state the labels say must not come out of a scene. A claim
 * the labels expect proved (the Captain's slate-grey eyes beside the negated blue) is no negative.
 */
function negativesStored(book: TestBookProject, claims: readonly Claim[]): string[] {
  const proved = TEST_BOOK_LABELS.claims.filter((label) => label.expect !== 'reject')
  const labelled = (claim: Claim): boolean =>
    proved.some(
      (label) =>
        label.scene === sceneOf(book, claim.nodeId) &&
        book.records.get(label.record) === claim.recordId &&
        slotOf(label) === claim.slot &&
        overlaps(label.quote, claim.quote)
    )
  return TEST_BOOK_LABELS.negatives.flatMap((negative) => {
    if (negative.kind !== 'claim' && negative.kind !== 'state') return []
    if (negative.record === undefined) return []
    const recordId = book.records.get(negative.record)
    const hits = claims.filter(
      (claim) =>
        sceneOf(book, claim.nodeId) === negative.scene &&
        claim.recordId === recordId &&
        (negative.slot === undefined || claim.slot === negative.slot) &&
        (negative.kind === 'claim' || setsState(claim)) &&
        !labelled(claim)
    )
    return hits.map(
      (claim) => `${negative.scene} ${negative.record} ${claim.slot} “${claim.value}”`
    )
  })
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
    const claims = liveClaims(book)
    for (const wanted of TEST_BOOK_LABELS.claims.filter((claim) => claim.expect !== 'reject')) {
      const stored = storedFor(book, claims, wanted)
      expect(stored, wanted.id).toBeDefined()
      expect(stored?.proof, wanted.id).toBe(wanted.expect)
      expect([stored?.voice, stored?.mode], wanted.id).toEqual([wanted.voice, wanted.mode])
    }
  })

  it('stores exactly those: no reject label and no negative is live, and nothing else', () => {
    const claims = liveClaims(book)
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
    const strays = liveClaims(book).filter(
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
    expect(negativesStored(book, liveClaims(book))).toEqual([])
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
    const claims = liveClaims(book)
    const lie = storedFor(book, claims, label('dunmore-clergyman'))
    expect([lie?.voice, lie?.mode]).toEqual(['dialogue', 'now'])
    expect(storedFor(book, claims, label('varrow-eyes-grey'))?.proof).toBe('literal')
    // The pronoun trap answered as one woman waits on both; nobody's eyes are green.
    expect(storedFor(book, claims, label('green-eyes-trap'))).toBeUndefined()
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

/** The live run's pass bars (decided by Claude, unconfirmed; plan P2a §2.7). */
export const PLANTED_PASS_BARS = {
  quotesFound: 0.9,
  verifierPass: 0.8,
  attribution: 0.95,
  literalPrecision: 0.98,
  /** Verified claims on a labelled sentence, with the label's record (2026-10-12 review). */
  supportPrecision: 0.9
} as const

/** The live run stops reading once its reported cost passes this. */
const LIVE_STOP_USD = 0.5

function liveModels(openRouter: boolean): Record<Tier, string> {
  const base = openRouter ? OPENROUTER_DEFAULT_MODELS : DEFAULT_MODELS
  return {
    fast: process.env.MYTHSCRIBE_EVAL_FAST_MODEL ?? base.fast,
    strong: process.env.MYTHSCRIBE_EVAL_STRONG_MODEL ?? base.strong
  }
}

describe.skipIf(!LIVE)('the live planted-error run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('reads the test book with the real provider, scores it per slot, and writes the report', async () => {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('The live planted-error run needs OPENAI_API_KEY in the environment.')
    const baseURL = process.env.OPENAI_BASE_URL
    const openRouter = baseURL?.includes('openrouter.ai') === true
    const models = liveModels(openRouter)
    const provider = buildOpenAiProvider(key, {
      ...(baseURL === undefined ? {} : { baseURL }),
      openRouter,
      id: openRouter ? 'openrouter' : 'openai',
      label: openRouter ? 'OpenRouter' : 'OpenAI',
      resolveModel: (tier) => models[tier]
    })
    const ledger: UsageEntry[] = []
    const cache = new Map<string, CachedResponse>()
    const ai: AiRequestDeps = {
      providers: { get: () => provider },
      ledger: { insert: (entry) => void ledger.push(entry) },
      cache: {
        get: (cacheKey) => cache.get(cacheKey),
        put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
      },
      dailyCap: {
        get: () => ({ ...defaultAiUsageState(), dailyCapUsd: 500, spentDate: dayOf(new Date()) }),
        spend: () => {}
      },
      session: { spend: () => {} },
      now: () => new Date(),
      price: priceFor,
      // Auto routing, so the reader and the checker ask for no reasoning as the app does.
      routing: () => ({ routing: defaultAiRouting(), table: autoTable(null) })
    }
    const spent = (): number => ledger.reduce((sum, entry) => sum + entry.costUsd, 0)

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-live-'))
    const book = buildTestBookProject(tmp, NOW)
    try {
      const events: (ReadingItemEvent & { scene: string })[] = []
      const outcomes = await readBook(
        book,
        ai,
        (event, scene) => events.push({ ...event, scene }),
        () => spent() > LIVE_STOP_USD
      )

      // The spot checks: up to 50 literal claims on the fast tier (batches of 10), up to 20
      // verified ones on the strong tier, one per call with three sentences either side.
      const claims = liveClaims(book)
      const roster = readerRoster(book.db)
      const item = (claim: Claim, around: number): VerifyV2Item => {
        const texts = sceneTexts(book.db, claim.nodeId)
        const sentences = sceneSentences(texts)
        const at = sentences.findIndex(
          (sentence) => sentence.p === claim.para && overlaps(sentence.text, claim.quote)
        )
        return {
          kind: 'claim',
          who: claim.recordId === null ? [] : [roster.whoLine(claim.recordId)],
          fact: `${claim.slot}: ${claim.value} (${claim.voice}, ${claim.mode})`,
          text: sentences
            .slice(Math.max(0, at - around), at + around + 1)
            .map((sentence) => sentence.text)
            .join(' ')
        }
      }
      const spot = { fastAgree: 0, fastChecked: 0, strongAgree: 0, strongChecked: 0 }
      // The 50¢ stop holds through the spot checks too: checked before every request.
      let stopped = spent() > LIVE_STOP_USD
      const over = (): boolean => {
        stopped ||= spent() > LIVE_STOP_USD
        return stopped
      }
      if (!stopped) {
        const literal = claims
          .filter((claim) => claim.proof === 'literal')
          .slice(0, 50)
          .map((claim) => item(claim, 1))
        const batches: VerifyV2Item[][] = []
        for (let i = 0; i < literal.length; i += 10) batches.push(literal.slice(i, i + 10))
        for (const batch of batches) {
          if (over()) break
          const prompt = buildVerifyV2Prompt({ items: batch })
          const result = await runAiRequest(ai, {
            feature: 'verify',
            tier: 'fast',
            messages: prompt.messages,
            maxTokens: prompt.maxTokens,
            json: true,
            contextHash: sha256(JSON.stringify(prompt.messages)),
            promptVersion: prompt.version
          })
          const verdicts = parseLive(result.text)
          spot.fastChecked += batch.length
          spot.fastAgree += batch.filter((_, i) => verdicts.get(i + 1) === true).length
        }
        for (const claim of claims.filter((each) => each.proof === 'verified').slice(0, 20)) {
          if (over()) break
          const prompt = buildVerifyV2Prompt({ items: [item(claim, 3)], strong: true })
          const result = await runAiRequest(ai, {
            feature: 'verify',
            tier: 'strong',
            messages: prompt.messages,
            maxTokens: prompt.maxTokens,
            json: true,
            contextHash: sha256(JSON.stringify(prompt.messages)),
            promptVersion: prompt.version
          })
          spot.strongChecked += 1
          if (parseLive(result.text).get(1) === true) spot.strongAgree += 1
        }
      }

      const report = scoreLive(book, events, outcomes, spot, {
        models,
        costUsd: spent(),
        stopped,
        requests: ledger.length,
        openRouter
      })
      const dir = path.resolve('test-results/eval-memory')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(path.join(dir, `planted-${stamp}.md`), report.markdown)
      fs.writeFileSync(
        path.join(dir, `planted-${stamp}.json`),
        JSON.stringify(report.json, null, 2)
      )
      process.stdout.write(`\n${report.markdown}\n`)
      expect(report.failures).toEqual([])
    } finally {
      book.session.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, 900_000)
})

/** A checker reply's verdicts as item → ok. */
function parseLive(text: string): Map<number, boolean> {
  const out = new Map<number, boolean>()
  try {
    const parsed = JSON.parse(text) as { v?: { i?: unknown; ok?: unknown }[] }
    for (const verdict of parsed.v ?? []) {
      if (typeof verdict.i === 'number' && typeof verdict.ok === 'boolean')
        out.set(verdict.i, verdict.ok)
    }
  } catch {
    // Not JSON: no verdicts, every item disagrees.
  }
  return out
}

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
    requests: number
    openRouter: boolean
  }
): { markdown: string; json: unknown; failures: string[] } {
  const claims = liveClaims(book)
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

  // Attribution: stored facts on a labelled quote and slot, with the label's subject.
  const matched = claims.flatMap((claim) => {
    const hit = TEST_BOOK_LABELS.claims.find(
      (label) =>
        label.scene === sceneOf(book, claim.nodeId) &&
        slotOf(label) === claim.slot &&
        overlaps(label.quote, claim.quote)
    )
    return hit === undefined ? [] : [{ claim, label: hit }]
  })
  const attributed = matched.filter(
    ({ claim, label }) => book.records.get(label.record) === claim.recordId
  ).length
  const literal = claims.filter((claim) => claim.proof === 'literal')
  const literalRight = literal.filter((claim) =>
    matched.some(
      (entry) =>
        entry.claim === claim &&
        entry.label.expect !== 'reject' &&
        book.records.get(entry.label.record) === claim.recordId
    )
  ).length
  // Support: verified claims on a labelled sentence that the label proves, about its record.
  const verified = claims.filter((claim) => claim.proof === 'verified')
  const verifiedMatched = verified.filter((claim) => matched.some((entry) => entry.claim === claim))
  const verifiedRight = verifiedMatched.filter((claim) =>
    matched.some(
      (entry) =>
        entry.claim === claim &&
        entry.label.expect !== 'reject' &&
        book.records.get(entry.label.record) === claim.recordId
    )
  ).length
  // Stored claims on no labelled sentence: no bar can judge them, so each is listed for review.
  const nameOfRecord = new Map([...book.records].map(([labelId, id]) => [id, nameOf.get(labelId)]))
  const unreviewed = claims
    .filter((claim) => !matched.some((entry) => entry.claim === claim))
    .map(
      (claim) =>
        `${sceneOf(book, claim.nodeId)} ¶${claim.para} ${nameOfRecord.get(claim.recordId ?? '') ?? '?'} ` +
        `${claim.slot} “${claim.value}” (${claim.proof}, ${claim.voice}, ${claim.mode}) ← “${claim.quote}”`
    )

  // Names: proposed, and those the twin gate ties to a record (a twin it caught).
  const names = [...new Set(events.flatMap((event) => (event.name === null ? [] : [event.name])))]
  const roster = rosterOf(book.db)
  const dismissed = dismissedNames(book.db)
  const twins = names.filter((name) => twinGate(name, roster, dismissed).outcome === 'blocked')

  // The health gate's measures, from the readings' own yields.
  const readings = [...book.scenes]
    .filter(([id]) => id !== 'h10')
    .flatMap(([, node]) => {
      const reading = lastReading(book.db, node, activeDraftId(book.db))
      return reading === null ? [] : [reading]
    })
  const sum = (pick: (yields: (typeof readings)[number]['yields']) => number): number =>
    readings.reduce((total, reading) => total + pick(reading.yields), 0)
  const proposed = sum((yields) => yields.items)
  const found = sum((yields) => yields.quotesFound)
  const sentToVerifier = sum((yields) => yields.verifySent)
  const passed = sum((yields) => yields.verified)
  const cutReadings = readings.filter((reading) => reading.finishReason === 'length').length
  const readCount = [...outcomes.values()].filter((outcome) => outcome === 'read').length
  const falseAlarms = negativesStored(book, claims)
  const strays = neverRead(book)

  const failures: string[] = []
  const bar = (name: string, value: number, whole: number, min: number): void => {
    if (whole > 0 && value / whole < min)
      failures.push(`${name} ${percent(value, whole)} < ${min * 100} %`)
  }
  bar('quotes found', found, proposed, PLANTED_PASS_BARS.quotesFound)
  bar('verifier pass', passed, sentToVerifier, PLANTED_PASS_BARS.verifierPass)
  bar('attribution precision', attributed, matched.length, PLANTED_PASS_BARS.attribution)
  bar('literal precision', literalRight, literal.length, PLANTED_PASS_BARS.literalPrecision)
  bar(
    'support precision',
    verifiedRight,
    verifiedMatched.length,
    PLANTED_PASS_BARS.supportPrecision
  )
  if (strays.length > 0) failures.push(`${strays.length} claims from never-read scenes`)
  if (falseAlarms.length > 0) failures.push(`${falseAlarms.length} negatives stored live`)

  const lines = [
    `# Story memory: the live planted-error run (${new Date().toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`${run.openRouter ? ' (OpenRouter)' : ''}. ` +
      `Scenes read: ${readCount}; requests: ${run.requests}; reported cost: ${run.costUsd.toFixed(4)} USD` +
      `${run.stopped ? ` (stopped at the ${LIVE_STOP_USD} USD cap)` : ''}.`,
    '',
    '## Pass bars (decided by Claude, unconfirmed)',
    '',
    `- Quotes found: ${percent(found, proposed)} (bar ${PLANTED_PASS_BARS.quotesFound * 100} %)`,
    `- Verifier pass: ${percent(passed, sentToVerifier)} (bar ${PLANTED_PASS_BARS.verifierPass * 100} %)`,
    `- Attribution precision: ${percent(attributed, matched.length)} (bar ${PLANTED_PASS_BARS.attribution * 100} %)`,
    `- Literal precision: ${percent(literalRight, literal.length)} (bar ${PLANTED_PASS_BARS.literalPrecision * 100} %)`,
    `- Support precision: ${percent(verifiedRight, verifiedMatched.length)} (bar ${PLANTED_PASS_BARS.supportPrecision * 100} %; verified claims on labelled sentences, the label's record)`,
    `- Stored on no labelled sentence (unreviewed, listed below): ${unreviewed.length} of ${claims.length}`,
    `- Claims from never-read scenes: ${strays.length} (bar 0)`,
    `- Negatives stored live (false alarms): ${falseAlarms.length} (bar 0)${falseAlarms.length > 0 ? `: ${falseAlarms.join('; ')}` : ''}`,
    `- Cut off at the cap (finish_reason length): ${percent(cutReadings, readCount)} of readings`,
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
    '## Unreviewed: stored on no labelled sentence',
    '',
    'No bar judges these: read each against its quote (a wrong person or an unsupported value is a',
    'failure of the run even when every bar passed).',
    '',
    ...(unreviewed.length === 0 ? ['None.'] : unreviewed.map((line) => `- ${line}`)),
    '',
    'Recall has no bar: sheets may be thinner than the labels. No prompt text and no key are written here.'
  ]
  return {
    markdown: lines.join('\n'),
    json: {
      models: run.models,
      costUsd: run.costUsd,
      stopped: run.stopped,
      requests: run.requests,
      scenesRead: readCount,
      quotesFound: { found, proposed },
      verifierPass: { passed, sent: sentToVerifier },
      attribution: { right: attributed, matched: matched.length },
      literalPrecision: { right: literalRight, literal: literal.length },
      supportPrecision: { right: verifiedRight, matched: verifiedMatched.length },
      unreviewed,
      neverRead: strays.length,
      falseAlarms,
      cutReadings,
      names: { proposed: names.length, twins },
      spot,
      slots: Object.fromEntries(slots),
      failures
    },
    failures
  }
}
