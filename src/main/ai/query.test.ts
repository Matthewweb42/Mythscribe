import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, inputBudget, priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import {
  QUERY_ALSO_MAX,
  QUERY_ANSWER_MAX,
  QUERY_MAX_CITATIONS,
  QUERY_QUOTE_MAX,
  QUERY_SCENE_CHAR_FLOOR
} from '@shared/query'
import type { StoredSceneSummary } from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import type { ChatTurn } from './prompts/chat.v1'
import {
  fitQueryPrompt,
  QUERY_HISTORY_KEEP,
  parseQueryAnswer,
  runQuery,
  type QueryFullScene,
  type QueryInput,
  type QuerySummaryScene
} from './query'
import {
  AiCancelledError,
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 8, 17, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
/** The first manuscript documents in reading order. */
let scenes: string[]
let dailyCapUsd: number

/** The scene the question is about; every other scene says nothing about the ledger. */
const LEDGER =
  'The ledger sat on the mill desk where Tomas had left it. Mara copied the ledger twice and ' +
  'hid the copy under the elm in the north pasture.'
/** Another written scene: it names Mara, so it ranks as a candidate but never as the answer. */
const QUIET = 'Mara stood in the yard and the lantern would not stay lit.'
const QUOTE = 'Mara copied the ledger twice'
const QUESTION = 'Where did Mara hide the ledger?'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const summaryRow = (nodeId: string, index: number): StoredSceneSummary => ({
  nodeId,
  contentHash: `hash-${index}`,
  summary: `The lantern goes out in room ${index}.`,
  keyPoints: ['The crossing is shut.'],
  characters: ['Tomas'],
  promptVersion: 'summary.v1',
  model: 'gpt-fake',
  truncated: false,
  createdAt: NOW.toISOString()
})

interface ModelCitation {
  scene?: unknown
  quote?: unknown
}

/** One answer, as the JSON the prompt asks for. */
const reply = (
  over: { found?: unknown; answer?: string; citations?: ModelCitation[] } = {}
): CompletionResult => ({
  text: JSON.stringify({ found: true, answer: 'Under the elm. [1]', ...over }),
  model: 'gpt-5.4',
  usage: { inputTokens: 900, outputTokens: 60 }
})

/** The next answers, ahead of the default one the fixture stands up. */
function answers(
  ...replies: { found?: unknown; answer?: string; citations?: ModelCitation[] }[]
): void {
  for (const over of replies) complete.mockResolvedValueOnce(reply(over))
}

const ask = (over: Partial<QueryInput> = {}): ReturnType<typeof runQuery> =>
  runQuery(db, deps, { nodeId: null, message: QUESTION, history: [], ...over })

async function failure(over: Partial<QueryInput> = {}): Promise<{ code: string; message: string }> {
  try {
    await ask(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** The system turn of a request, as the provider saw it. */
const system = (call = 0): string => complete.mock.calls[call]?.[0].messages[0]?.content ?? ''

/** Settles like the adapter once its `signal` aborts: rejects with CANCELLED. */
const untilCancelled = (request: CompletionRequest): Promise<never> =>
  new Promise((_, reject) => {
    request.signal?.addEventListener(
      'abort',
      () => reject(new AiCancelledError('The request was stopped.')),
      { once: true }
    )
  })

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-query-'))
  session = createProject(projectFolderFor(tmp, 'Query'), 'Query', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  if (scenes.length < 4) throw new Error('skeleton not seeded')
  saveDocument(db, scenes[0]!, doc(LEDGER))
  saveDocument(db, scenes[1]!, doc(QUIET))
  saveDocument(db, scenes[2]!, doc(QUIET))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue(reply())
  ledger = []
  dailyCapUsd = defaultAiUsageState().dailyCapUsd
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const cache = new Map<string, { text: string; usage: CompletionResult['usage'] }>()
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), dailyCapUsd, spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runQuery (F-5.7)', () => {
  it('sends the ranked scenes as JSON to the strong tier under query.v1 and answers with citations', async () => {
    answers({ citations: [{ scene: 1, quote: QUOTE }] })
    const result = await ask()
    expect(result).toEqual({
      answer: 'Under the elm. [1]',
      found: true,
      uncited: false,
      citations: [{ nodeId: scenes[0], title: 'Chapter 1 › Scene 1', scene: 1, quote: QUOTE }],
      also: [
        { nodeId: scenes[1], title: 'Chapter 2 › Scene 1' },
        { nodeId: scenes[2], title: 'Chapter 3 › Scene 1' }
      ],
      dropped: 0,
      usage: { inputTokens: 900, outputTokens: 60 },
      costUsd: priceFor('gpt-5.4', 900, 60).costUsd,
      cached: false,
      model: 'gpt-5.4',
      promptVersion: 'query.v1'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'strong', json: true, maxTokens: 600 })
    expect('temperature' in request).toBe(false)
    expect(ledger[0]).toMatchObject({
      feature: 'query',
      tier: 'strong',
      promptVersion: 'query.v1',
      cached: false
    })
  })

  it('sends the best match first in full, never the whole manuscript', async () => {
    await ask()
    expect(system()).toContain(`[1] Chapter 1 › Scene 1\n"""\n${LEDGER}\n"""`)
    // The other written scenes still ride along, but only three ever go out in full.
    expect(system()).toContain('[3] Chapter 3 › Scene 1')
    expect(system()).not.toContain('[4]')
  })

  it('sends the candidates below the full ones as their stored summaries only', async () => {
    const documents = manuscriptDocuments(db)
    expect(documents.length).toBeGreaterThan(4)
    documents.forEach((row, index) => {
      saveDocument(db, row.id, doc(index === 0 ? LEDGER : `${QUIET} Room ${index}.`))
      // Only the candidates below the three that go out in full have a stored summary here.
      if (index >= 4) upsertSummary(db, summaryRow(row.id, index))
    })
    await ask()
    expect(system()).toContain('Other scenes (summaries only):\n[4] ')
    expect(system()).toContain('The lantern goes out in room 4.')
    // A summarised candidate rides along as its summary only: its text never goes out.
    expect(system()).not.toContain('Room 4.')
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Story Intelligence needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, query: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Story Intelligence is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses with VALIDATION when no scene has been written yet', async () => {
    for (const id of scenes) saveDocument(db, id, { type: 'doc', content: [] })
    const empty = await failure()
    expect(empty.code).toBe('VALIDATION')
    expect(empty.message).toContain('Write a scene before asking')
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers the same question from the cache, and misses it when a scene changes', async () => {
    await ask()
    await ask()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    saveDocument(db, scenes[0]!, doc(`${LEDGER} She did not look back.`))
    await ask()
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('carries the conversation as real turns and drops the oldest ones only to fit', async () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'Who is Tomas?' },
      { role: 'assistant', content: 'The man the mill owes.' }
    ]
    await ask({ history })
    expect(complete.mock.calls[0]![0].messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
  })

  it('lets a budget refusal and a provider error propagate, logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    complete.mockReset()
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
  })

  it('hands the requestId to the provider as its signal, and a cancel rejects with CANCELLED (F-5.10)', async () => {
    complete.mockReset()
    complete.mockImplementationOnce(untilCancelled)
    const pending = ask({ requestId: 'q-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('q-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
  })
})

describe('runQuery citations (F-5.7)', () => {
  it('drops a fabricated quote and a scene that never went out, and strips their markers', async () => {
    answers({
      answer: 'Under the elm [1], beside the river [2], after the thaw [9].',
      citations: [
        { scene: 1, quote: QUOTE },
        { scene: 2, quote: 'The dragon circled the keep.' },
        { scene: 9, quote: QUOTE }
      ]
    })
    const result = await ask()
    expect(result.citations).toHaveLength(1)
    expect(result.dropped).toBe(2)
    expect(result.answer).toBe('Under the elm [1], beside the river, after the thaw.')
    expect(result.uncited).toBe(false)
  })

  it('flags an answer no citation survived as uncited, and lists the ranked scenes as "also"', async () => {
    answers({ answer: 'Somewhere upstream. [1]', citations: [{ scene: 1, quote: 'nowhere' }] })
    const result = await ask()
    expect(result).toMatchObject({
      found: true,
      uncited: true,
      citations: [],
      dropped: 1,
      answer: 'Somewhere upstream.'
    })
    expect(result.also.map((ref) => ref.nodeId)).toEqual([scenes[0], scenes[1], scenes[2]])
  })

  it('names at most the "Also mentioned in" cap, best match first', async () => {
    const chapter = listNodes(db).find((row) => row.id === scenes[0])?.parentId ?? ''
    expect(chapter).not.toBe('')
    for (let index = 0; index < 6; index++) {
      const extra = createNode(db, 'novel', {
        parentId: chapter,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `Extra ${index}`
      })
      saveDocument(db, extra.id, doc(`${QUIET} Room ${index}.`))
    }
    answers({ citations: [{ scene: 1, quote: QUOTE }] })
    const result = await ask()
    expect(result.also).toHaveLength(QUERY_ALSO_MAX)
    expect(result.also.some((ref) => ref.nodeId === scenes[0])).toBe(false)
  })

  it('answers "not found" without citations and without counting them as dropped', async () => {
    answers({
      found: false,
      answer: 'The scenes name the ledger but never say where it went. [1]',
      citations: [{ scene: 1, quote: QUOTE }]
    })
    expect(await ask()).toMatchObject({
      found: false,
      uncited: false,
      citations: [],
      dropped: 0,
      answer: 'The scenes name the ledger but never say where it went.'
    })
  })

  it('answers PROVIDER when the model does not reply in the expected shape', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'Under the elm!',
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 5 }
    })
    expect((await failure()).code).toBe('PROVIDER')
  })
})

describe('parseQueryAnswer (F-5.7)', () => {
  const SCENES: QueryFullScene[] = [
    { nodeId: 'a', title: 'Chapter 1 › Scene 1', text: LEDGER.repeat(4) },
    { nodeId: 'b', title: 'Chapter 2 › Scene 1', text: QUIET }
  ]
  const parse = (reply: Record<string, unknown>): ReturnType<typeof parseQueryAnswer> =>
    parseQueryAnswer(JSON.stringify(reply), SCENES)

  it('coerces found, trims and caps the answer, and caps a quote', () => {
    expect(parse({ found: 1, answer: '  Under the elm.  ' })).toMatchObject({
      found: true,
      answer: 'Under the elm.'
    })
    expect(parse({ found: 'no', answer: 'x' }).found).toBe(true)
    expect(parse({ found: 0, answer: 'x' }).found).toBe(false)
    const long = parse({ found: true, answer: 'x'.repeat(QUERY_ANSWER_MAX + 50) })
    expect(long.answer).toHaveLength(QUERY_ANSWER_MAX)
    const quote = parse({
      found: true,
      answer: 'a [1]',
      citations: [{ scene: 1, quote: LEDGER.repeat(3) }]
    })
    expect(quote.citations[0]!.quote).toHaveLength(QUERY_QUOTE_MAX)
  })

  it('drops a citation with a bad shape, a scene out of range, or a blank quote', () => {
    const result = parse({
      found: true,
      answer: 'a',
      citations: [
        { scene: 'one', quote: QUOTE },
        { scene: 0, quote: QUOTE },
        { scene: 3, quote: QUOTE },
        { scene: 1.5, quote: QUOTE },
        { scene: 1, quote: '   ' },
        { quote: QUOTE }
      ]
    })
    expect(result.citations).toHaveLength(0)
    expect(result.dropped).toBe(6)
  })

  it('matches the quote through the shared normalization and keeps the first of each duplicate', () => {
    const wrapped = 'Mara copied the\n  ledger twice'
    const result = parse({
      found: true,
      answer: 'a [1]',
      citations: [
        { scene: 1, quote: `  ${wrapped}  ` },
        { scene: 1, quote: QUOTE }
      ]
    })
    expect(result.citations).toEqual([
      { nodeId: 'a', title: 'Chapter 1 › Scene 1', scene: 1, quote: wrapped }
    ])
    expect(result.dropped).toBe(0)
  })

  it('caps the citations at the maximum', () => {
    const many = Array.from({ length: QUERY_MAX_CITATIONS + 3 }, (_, index) => ({
      scene: 1,
      quote: LEDGER.slice(index, 40 + index)
    }))
    expect(parse({ found: true, answer: 'a', citations: many }).citations).toHaveLength(
      QUERY_MAX_CITATIONS
    )
  })

  it('refuses an answer that is not JSON or carries no answer string at all', () => {
    expect(() => parseQueryAnswer('nope', SCENES)).toThrowError(/expected format/)
    expect(() => parseQueryAnswer('{"found":true}', SCENES)).toThrowError(/expected format/)
  })
})

describe('fitQueryPrompt (F-5.7, token rule 8)', () => {
  const scene = (index: number, length: number): QueryFullScene => ({
    nodeId: `full-${index}`,
    title: `Scene ${index}`,
    text: 'x'.repeat(length)
  })
  const summary = (index: number): QuerySummaryScene => ({
    nodeId: `summary-${index}`,
    contentHash: `hash-${index}`,
    title: `Summary ${index}`,
    summary: 's'.repeat(600),
    keyPoints: ['k'.repeat(140)]
  })
  const history = (count: number): ChatTurn[] =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'h'.repeat(2_000)
    }))
  const build = (
    full: QueryFullScene[],
    summaries: QuerySummaryScene[],
    turns: ChatTurn[]
  ): { role: 'user'; content: string }[] => [
    {
      role: 'user',
      content: [
        ...full.map((s) => s.text),
        ...summaries.map((s) => `${s.summary}${s.keyPoints.join('')}`),
        ...turns.map((turn) => turn.content)
      ].join('\n')
    }
  ]
  const tokens = (fit: ReturnType<typeof fitQueryPrompt>): number =>
    estimateTokens(build(fit.full, fit.summaries, fit.history)[0]!.content)

  it('sends everything untouched when it already fits', () => {
    const input = { full: [scene(0, 400)], summaries: [summary(0)], history: history(2) }
    expect(fitQueryPrompt(input, inputBudget('query'), build)).toEqual(input)
  })

  it('shrinks the longest scene to the floor before it drops anything', () => {
    const input = { full: [scene(0, 12_000), scene(1, 4_000)], summaries: [], history: [] }
    const fit = fitQueryPrompt(input, 3_000, build)
    expect(fit.full).toHaveLength(2)
    // The longest scene is the one that loses characters; the short one is untouched.
    expect(fit.full[0]!.text.length).toBeLessThan(12_000)
    expect(fit.full[0]!.text.length).toBeGreaterThan(QUERY_SCENE_CHAR_FLOOR)
    expect(fit.full[1]!.text).toHaveLength(4_000)
    expect(tokens(fit)).toBeLessThanOrEqual(3_000)
  })

  it('then drops the summaries, lowest-ranked first', () => {
    const input = {
      full: [scene(0, 12_000)],
      summaries: [summary(0), summary(1), summary(2)],
      history: []
    }
    const fit = fitQueryPrompt(input, 800, build)
    expect(fit.summaries.map((s) => s.nodeId)).toEqual([])
    expect(fit.full).toHaveLength(1)
  })

  it('then drops the lowest-ranked full scenes but always keeps the best match', () => {
    const input = {
      full: [scene(0, 12_000), scene(1, 12_000), scene(2, 12_000)],
      summaries: [],
      history: []
    }
    const fit = fitQueryPrompt(input, 800, build)
    expect(fit.full.map((s) => s.nodeId)).toEqual(['full-0'])
    expect(fit.full[0]!.text.length).toBe(QUERY_SCENE_CHAR_FLOOR + 1)
  })

  it('drops the oldest history turns down to the last exchange before losing a full scene', () => {
    const input = {
      full: [scene(0, 3_000), scene(1, 3_000)],
      summaries: [],
      history: history(6)
    }
    const fit = fitQueryPrompt(input, 2_600, build)
    expect(fit.full.map((s) => s.nodeId)).toEqual(['full-0', 'full-1'])
    // What is kept is the end of the conversation, which is the part the question follows on from.
    expect(fit.history).toEqual(history(6).slice(6 - QUERY_HISTORY_KEEP))
  })

  it('drops the remaining history last of all', () => {
    const input = { full: [scene(0, 3_000)], summaries: [], history: history(4) }
    const fit = fitQueryPrompt(input, 800, build)
    expect(fit.full).toHaveLength(1)
    expect(fit.history).toEqual([])
  })

  it('never produces more than one ellipsis when a scene is shrunk twice', () => {
    const input = { full: [scene(0, 12_000)], summaries: [], history: [] }
    const fit = fitQueryPrompt(input, 800, build)
    expect(fit.full[0]!.text.match(/…/g)).toHaveLength(1)
  })
})
