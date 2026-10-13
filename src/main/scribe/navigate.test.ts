import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import type { AgentStep } from '@shared/agent'
import { defaultAiSettings } from '@shared/aiSettings'
import type { ReadNowResult } from '@shared/memory/views'
import { InstantCard } from '@shared/scribe'
import { claim, card, reading } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { defaultAiUsageState, dayOf } from '../ai/dailyCap'
import { resetInflight } from '../ai/inflight'
import { NAVIGATOR_SENTINEL } from '../ai/prompts/navigator.v1'
import { ROUTE_RULES_V2 } from '../ai/prompts/route.v2'
import type { CompletionRequest, CompletionResult, Provider } from '../ai/providers/types'
import { AiRateLimitError } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import type { UsageEntry } from '../ai/usageStore'
import { seedClaims } from '../memory/reading/claimFixture'
import { getClaim } from '../memory/reading/claimStore'
import { setAiSettings } from '../project/settingsStore'
import { READING_FIRST, runNavigate, turnOfWords, type NavigateInput } from './navigate'
import { gatherStep0 } from './step0'
import {
  closeScribeBook,
  doc,
  indexBook,
  readWhole,
  SCRIBE_NOW,
  scribeBook,
  type ScribeBook
} from './scribeFixture'

/**
 * Ms Scribe's navigation (F-16.24, F-16.25; plan P3 §4.4): a typed action and an instant card send
 * nothing; a stale value goes to Ms Scribe with no navigator call; the latest change is read
 * first; `navigator.v1` routes F-5.26's edit passes and every other action as route.v2 did, and
 * for a question searches in at most three steps and names the evidence. Nothing is written.
 */

type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let book: ScribeBook
let complete: ReturnType<typeof vi.fn<Complete>>
let readNow: ReturnType<typeof vi.fn<(nodeId: string, requestId: string) => Promise<ReadNowResult>>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let steps: AgentStep[]

const said = (value: unknown): CompletionResult => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  model: 'gpt-5.4-mini',
  usage: { inputTokens: 900, outputTokens: 30 }
})

function replies(...values: unknown[]): void {
  for (const value of values) complete.mockResolvedValueOnce(said(value))
}

const request = (call: number): CompletionRequest => {
  const value = complete.mock.calls[call]?.[0]
  if (!value) throw new Error(`no request ${call}`)
  return value
}

const run = (over: Partial<NavigateInput> = {}): ReturnType<typeof runNavigate> =>
  runNavigate(
    book.db,
    deps,
    { readNow },
    {
      nodeId: book.two,
      message: 'What did Orrin hear?',
      history: [],
      focus: { beforeCaret: '', selection: '' },
      requestId: 'r1',
      ...over
    },
    (step) => steps.push(step)
  )

const counts = (): number[] =>
  [claim, card, reading].map((table) => book.db.select().from(table).all().length)

beforeEach(() => {
  resetInflight()
  book = scribeBook()
  for (const id of [book.one, book.two, book.three]) readWhole(book.db, id)
  indexBook(book.db, {
    scenes: [book.one, book.two, book.three],
    records: [book.mara, book.orrin, book.tomas, book.quay]
  })
  setAiSettings(book.db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue(said({ a: 'chat', t: 'answer', use: ['E1'] }))
  readNow = vi.fn()
  ledger = []
  steps = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete: (req) => complete(req),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error('the navigator never streams')
    },
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => undefined },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(SCRIBE_NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => SCRIBE_NOW,
    price: priceFor
  }
})
afterEach(() => closeScribeBook(book))

const grey = (state: 'live' | 'stale' = 'live'): string[] =>
  seedClaims(
    book.db,
    book.one,
    [{ recordId: book.mara, slot: 'eyes', value: 'grey', quote: 'her grey eyes', para: 0, state }],
    SCRIBE_NOW
  )

describe('no request (F-16.24): a typed action, an instant card, a lookup handed over', () => {
  it('runs a typed action name with no request, as the router did', async () => {
    const result = await run({ message: 'Proofread' })
    expect(result).toMatchObject({
      kind: 'route',
      decision: { action: 'proofread', instruction: null, edit: null },
      routedBy: 'local',
      costUsd: 0
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers "Mara’s eyes?" with an instant card and no AI call', async () => {
    const [claimId] = grey()
    const before = counts()
    const result = await run({ message: 'Mara’s eyes?' })
    expect(result.kind).toBe('instant')
    if (result.kind !== 'instant') throw new Error('no card')
    expect(result.card).toMatchObject({
      kind: 'slot',
      value: 'grey',
      claimId,
      ref: '1.1',
      readFirst: null
    })
    expect(InstantCard.safeParse(result.card).success).toBe(true)
    expect(result.costUsd).toBe(0)
    expect(complete).not.toHaveBeenCalled()
    expect(readNow).not.toHaveBeenCalled()
    expect(counts()).toEqual(before)
  })

  it('reads the latest change first (one reader request), then answers with the card and its cost', async () => {
    seedClaims(
      book.db,
      book.one,
      [
        {
          recordId: book.mara,
          slot: 'location',
          value: 'the quay',
          quote: 'watched the quay',
          para: 0
        }
      ],
      SCRIBE_NOW
    )
    saveDocument(book.db, book.two, doc('Mara walked to the harbour.'))
    readNow.mockImplementation((nodeId) => {
      seedClaims(
        book.db,
        nodeId,
        [
          {
            recordId: book.mara,
            slot: 'location',
            value: 'the harbour',
            quote: 'Mara walked to the harbour',
            para: 0
          }
        ],
        SCRIBE_NOW
      )
      readWhole(book.db, nodeId)
      return Promise.resolve({ ok: true, read: true, reason: null, readingId: 'x', costUsd: 0.001 })
    })
    const result = await run({ message: 'Where is Mara?' })
    expect(readNow).toHaveBeenCalledTimes(1)
    expect(readNow.mock.calls[0]).toEqual([book.two, 'r1:read1'])
    expect(steps).toEqual([{ tool: 'read', label: READING_FIRST }])
    expect(result).toMatchObject({
      kind: 'instant',
      card: { kind: 'slot', value: 'the harbour', lastStated: true, readFirst: { costUsd: 0.001 } },
      costUsd: 0.001
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('checks the scene’s anchors before the read-first, so the read re-checks the old value', async () => {
    saveDocument(book.db, book.two, doc('Mara’s eyes were grey.', 'Mara sat down.'))
    const [claimId = ''] = seedClaims(
      book.db,
      book.two,
      [
        {
          recordId: book.mara,
          slot: 'eyes',
          value: 'grey',
          quote: 'Mara’s eyes were grey',
          para: 0
        }
      ],
      SCRIBE_NOW
    )
    readWhole(book.db, book.two)
    // Edited and saved a moment ago: the anchors job has not looked yet, so the claim is live.
    saveDocument(book.db, book.two, doc('Mara’s eyes were brown.', 'Mara sat down.'))
    expect(getClaim(book.db, claimId)?.state).toBe('live')
    const seen: (string | undefined)[] = []
    readNow.mockImplementation(() => {
      seen.push(getClaim(book.db, claimId)?.state)
      return Promise.resolve({ ok: false, code: 'DISABLED', message: 'off', nextStep: '' })
    })
    await run({ message: 'Mara’s eyes?' })
    expect(readNow).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['stale'])
  })

  it('hands a read the reader cannot make now to Ms Scribe as a lookup (E0 has the change)', async () => {
    grey()
    saveDocument(book.db, book.two, doc('Mara’s eyes were green now.', 'Mara sat down.'))
    readNow.mockResolvedValue({ ok: false, code: 'DISABLED', message: 'off', nextStep: '' })
    const result = await run({ message: 'Mara’s eyes?' })
    expect(result).toMatchObject({
      kind: 'answer',
      action: 'query',
      navigation: { turn: 'lookup' }
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('hands a stale value to Ms Scribe as a lookup with that slot’s claims first, and no navigator call', async () => {
    const [claimId] = grey('stale')
    const result = await run({ message: 'Mara’s eyes?' })
    expect(result.kind).toBe('answer')
    if (result.kind !== 'answer') throw new Error('no answer')
    expect(result.action).toBe('query')
    expect(result.routedBy).toBe('local')
    expect(result.navigation?.turn).toBe('lookup')
    expect(result.navigation?.evidence[0]).toEqual({ kind: 'claim', claimId })
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers from Step 0’s evidence when the navigator is off, with no request', async () => {
    const settings = defaultAiSettings()
    setAiSettings(book.db, {
      ...settings,
      dial: 1,
      features: { ...settings.features, navigator: false }
    })
    const result = await run({ message: 'Make this scene better.' })
    expect(result).toMatchObject({
      kind: 'answer',
      action: 'chat',
      navigation: null,
      routedBy: 'local'
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses when Ms Scribe herself is off', async () => {
    const settings = defaultAiSettings()
    setAiSettings(book.db, {
      ...settings,
      dial: 1,
      features: { ...settings.features, agent: false }
    })
    await expect(run({ message: 'Make this scene better.' })).rejects.toMatchObject({
      code: 'DISABLED'
    })
  })
})

describe('routing (F-5.26 kept, P3-D7): navigator.v1 in place of route.v2', () => {
  it('asks "What should I focus on?" for a vague request: editPass ask on the scene, one navigator request, never route.v2', async () => {
    replies({ a: 'editPass', t: 'edit', pass: 'ask', target: 'scene' })
    const result = await run({ message: 'Make this scene better.' })
    expect(result).toMatchObject({
      kind: 'route',
      decision: {
        action: 'editPass',
        instruction: null,
        edit: { pass: 'ask', target: 'scene', chapter: null }
      },
      routedBy: 'model'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const sent = request(0)
    expect(sent.messages[0]?.content.startsWith(NAVIGATOR_SENTINEL)).toBe(true)
    expect(sent.messages[0]?.content).not.toContain(ROUTE_RULES_V2)
    // Reasoning off: on a direct OpenAI key, its lowest effort (request.test covers every route).
    expect(sent.lowestEffort).toBe(true)
    expect(sent.maxTokens).toBe(150)
    expect(ledger.map((entry) => [entry.feature, entry.promptVersion])).toEqual([
      ['navigator', 'navigator.v1']
    ])
    expect(result.costUsd).toBeGreaterThan(0)
    expect(sent.messages[1]?.content).toContain('Open document: scene "Two"')
  })

  it('settles every pick as route.v2’s were: a specific pass, a named chapter, a rewrite without a selection, a consistency check', async () => {
    replies({ a: 'editPass', t: 'edit', pass: 'line', target: 'scene', i: 'Tighten the prose.' })
    expect(await run({ message: 'Tighten the prose.' })).toMatchObject({
      kind: 'route',
      decision: {
        action: 'editPass',
        instruction: 'Tighten the prose.',
        edit: { pass: 'line', target: 'scene' }
      }
    })
    replies({ a: 'editPass', pass: 'proofread', target: 'chapter', chapter: '3' })
    expect(await run({ message: 'Proofread chapter 3.', requestId: 'r2' })).toMatchObject({
      kind: 'route',
      decision: { action: 'editPass', edit: { pass: 'proofread', target: 'chapter', chapter: '3' } }
    })
    // A rewrite with nothing selected is an edit pass on the scene (F-5.26).
    replies({ a: 'rewrite', i: 'In my voice.' })
    expect(await run({ message: 'Rewrite this in my voice.', requestId: 'r3' })).toMatchObject({
      kind: 'route',
      decision: { action: 'editPass', edit: { pass: 'custom', target: 'scene' } }
    })
    for (const action of ['critique', 'betaReader', 'whatNext', 'synopsis', 'notes'] as const) {
      replies({ a: action })
      expect(await run({ message: `${action}, please`, requestId: `r-${action}` })).toMatchObject({
        kind: 'route',
        decision: { action }
      })
    }
    // F-16.4: a consistency check is answered as a question about the book until P4.
    replies({ a: 'continuity', t: 'answer' })
    expect(
      await run({ message: 'Check this scene for contradictions.', requestId: 'r4' })
    ).toMatchObject({
      kind: 'answer',
      action: 'query'
    })
  })

  it('answers from Step 0’s evidence when the first step is unreadable: never costs the turn', async () => {
    replies('Sure! Orrin heard Tomas.')
    const result = await run()
    expect(result).toMatchObject({
      kind: 'answer',
      action: 'chat',
      navigation: null,
      routedBy: 'model'
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('finding the evidence (F-16.25)', () => {
  it('searches in three steps at most, then names the evidence; the steps show in the chat', async () => {
    replies(
      { a: 'query', t: 'answer', call: [{ search: ['stranger', 'buyer'] }, { teleport: 'x' }] },
      { call: [{ read: '1.1 ¶1-2' }] },
      { use: ['E2', 'E99'] }
    )
    const before = counts()
    const result = await run({ message: 'Who bought the map?' })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(steps.map((step) => step.tool)).toEqual(['search', 'read'])
    // Step 2 carries step 1's reply and what it found; step 3 is told to end.
    expect(request(1).messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(request(1).messages[3]?.content).toContain('Step 2 of 3')
    expect(request(2).messages[5]?.content).toContain('Step 3 of 3: end with {"use":[…]}.')
    // The prefix and step 1's tail are sent as they were: the cache holds.
    expect(request(2).messages.slice(0, 2)).toEqual(request(0).messages.slice(0, 2))
    if (result.kind !== 'answer') throw new Error('no answer')
    expect(result.action).toBe('query')
    expect(result.skipped).toBe(1)
    expect(result.steps).toEqual(steps)
    expect(result.navigation?.turn).toBe('answer')
    expect(result.navigation?.terms).toEqual(expect.arrayContaining(['stranger', 'buyer']))
    expect(result.navigation?.hits).toEqual(
      expect.arrayContaining([
        { nodeId: book.one, para: 1 },
        { nodeId: book.one, para: 2 }
      ])
    )
    // E99 names nothing: only E2 is used.
    expect(result.navigation?.evidence).toHaveLength(1)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(ledger).toHaveLength(3)
    expect(counts()).toEqual(before)
  })

  it('ends at step 1 when the menu already answers (use), and uses the whole menu when it names nothing usable', async () => {
    replies({ a: 'query', t: 'answer', use: ['E1'] })
    const enough = await run()
    expect(complete).toHaveBeenCalledTimes(1)
    if (enough.kind !== 'answer') throw new Error('no answer')
    expect(enough.navigation?.evidence).toHaveLength(1)
    replies({ a: 'chat', t: 'answer' })
    const menu = await run({ requestId: 'r2', message: 'Who sold the map to a stranger?' })
    if (menu.kind !== 'answer') throw new Error('no answer')
    const step0 = gatherStep0(book.db, {
      nodeId: book.two,
      question: 'Who sold the map to a stranger?',
      focus: { caretPara: null, selection: null }
    })
    expect(menu.navigation?.evidence).toEqual(step0.menu.map((item) => item.key))
    expect(step0.menu.length).toBeGreaterThan(1)
  })

  it('keeps the scope of an every-earlier-scene search for a first question', async () => {
    replies(
      { a: 'query', t: 'answer', call: [{ search: ['suspected', 'doubted'] }] },
      { use: ['E1', 'E2'] }
    )
    const result = await run({
      nodeId: book.three,
      message: 'When does Mara first suspect the map was sold?'
    })
    if (result.kind !== 'answer') throw new Error('no answer')
    expect(result.navigation?.scope).toMatchObject({ from: '1.1', to: '1.3', allEarlier: true })
    expect(result.navigation?.scope?.terms).toEqual(
      expect.arrayContaining(['suspected', 'doubted'])
    )
  })

  it('answers from what it found when a later step fails, and fails the turn only for the first', async () => {
    replies({ a: 'query', t: 'answer', call: [{ search: ['stranger'] }] })
    complete.mockRejectedValueOnce(new AiRateLimitError('slow down'))
    const result = await run({ message: 'Who bought the map?' })
    expect(result.kind).toBe('answer')
    complete.mockRejectedValueOnce(new AiRateLimitError('slow down'))
    await expect(run({ message: 'Who bought the map?', requestId: 'r2' })).rejects.toBeInstanceOf(
      AiRateLimitError
    )
  })

  it('takes the turn’s kind from the words when the first step names none', async () => {
    replies({ a: 'chat', use: ['E1'] })
    const result = await run({ message: "Add to Mara's sheet that she hates the sea." })
    if (result.kind !== 'answer') throw new Error('no answer')
    expect(result.navigation?.turn).toBe('edit')
    expect(
      turnOfWords({
        change: false,
        sheetWrite: false,
        idea: true,
        scopeAll: false,
        knows: false,
        learns: false,
        wholeBook: false
      })
    ).toBe('idea')
  })

  it('never sends an absence: no navigator request says someone does not know', async () => {
    seedClaims(
      book.db,
      book.one,
      [
        {
          recordId: book.orrin,
          slot: 'knows',
          value: 'overheard',
          how: 'overheard',
          fromId: book.tomas,
          objectId: book.map,
          quote: 'Orrin overheard Tomas',
          para: 2,
          proof: 'verified'
        }
      ],
      SCRIBE_NOW
    )
    replies(
      { a: 'query', t: 'answer', call: [{ knows: 'the sold map' }, { knows: 'Mara' }] },
      { use: ['E1'] }
    )
    await run({ message: 'Does Mara know about the sold map?' })
    for (const call of complete.mock.calls) {
      const text = call[0].messages.map((m) => m.content).join('\n')
      expect(text).not.toMatch(
        /does not know|doesn't know|never learns|No scene shows|checked up to/iu
      )
    }
  })
})
