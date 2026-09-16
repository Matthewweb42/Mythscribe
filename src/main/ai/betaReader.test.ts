import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, inputBudget, priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import {
  BETA_READER_MAX_ITEMS,
  BETA_READER_NOTE_MAX,
  BETA_READER_QUOTE_MAX,
  BETA_READER_SCENE_CHAR_BUDGET,
  BETA_READER_SCENE_CHAR_FLOOR,
  BETA_READER_TEXT_MIN
} from '@shared/betaReader'
import type { StoredSceneSummary } from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { fitReadThrough, parseBetaReaderAnswer, runBetaReader, type BetaReaderInput } from './betaReader'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
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

const NOW = new Date(2026, 8, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
/** The scene the reader reads up to: the third manuscript document, so two scenes come before it. */
let scene: string
let earlier: string[]
let folder: string
let frontDoc: string
let dailyCapUsd: number

/** The scene under the reader's eye: over `BETA_READER_TEXT_MIN`, third person, past tense. */
const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'
const QUOTE = 'The rope hung slack in the water'
const NOTE = 'I know she came to meet someone she does not trust.'
/** A line of the first summary, so an item citing scene 1 has something to quote. */
const SUMMARY_QUOTE = 'Mara finds the ledger her brother copied'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const summaryRow = (nodeId: string, index: number): StoredSceneSummary => ({
  nodeId,
  contentHash: `hash-${index}`,
  summary: `${SUMMARY_QUOTE} and hides it under the floor of room ${index}.`,
  keyPoints: [`The ledger is a copy (${index}).`],
  characters: ['Mara'],
  promptVersion: 'summary.v1',
  model: 'gpt-5.4-mini',
  truncated: false,
  createdAt: NOW.toISOString()
})

interface ModelItem {
  category?: unknown
  scene?: unknown
  quote?: unknown
  note?: unknown
}

/** The next answer, as the JSON the prompt asks for. */
function answers(...reports: ModelItem[][]): void {
  for (const items of reports) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify({ items }),
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 120 }
    })
  }
}

const item = (over: ModelItem = {}): ModelItem => ({
  category: 'knows',
  scene: 3,
  quote: QUOTE,
  note: NOTE,
  ...over
})

const read = (over: Partial<BetaReaderInput> = {}): ReturnType<typeof runBetaReader> =>
  runBetaReader(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<BetaReaderInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await read(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** The messages of a request, as the provider saw them. */
const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-beta-reader-'))
  session = createProject(projectFolderFor(tmp, 'Reader'), 'Reader', 'novel')
  db = session.connection.orm
  const documents = manuscriptDocuments(db)
  scene = documents[2]?.id ?? ''
  earlier = documents.slice(0, 2).map((row) => row.id)
  const rows = listNodes(db)
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  const front = rows.find((r) => r.sectionType === 'front')
  if (!scene || earlier.length !== 2 || !folder || !front) throw new Error('skeleton not seeded')
  frontDoc = createNode(db, 'novel', {
    parentId: front.id,
    kind: 'document',
    hierarchyLevel: null,
    title: 'Dedication'
  }).id
  saveDocument(db, frontDoc, doc(SCENE))
  saveDocument(db, scene, doc(SCENE))
  earlier.forEach((id, index) => upsertSummary(db, summaryRow(id, index)))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers([item()])
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
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runBetaReader (F-14.11)', () => {
  it('sends the read-through as JSON to the strong tier under betaReader.v1 and answers the cited items', async () => {
    const result = await read()
    expect(result).toEqual({
      items: [{ category: 'knows', scene: 3, quote: QUOTE, note: NOTE }],
      scenes: [
        { nodeId: earlier[0], title: 'Chapter 1 › Scene 1', current: false },
        { nodeId: earlier[1], title: 'Chapter 2 › Scene 1', current: false },
        { nodeId: scene, title: 'Chapter 3 › Scene 1', current: true }
      ],
      truncated: false,
      skipped: 0,
      missing: 0,
      dropped: 0,
      usage: { inputTokens: 900, outputTokens: 120 },
      costUsd: priceFor('gpt-5.4', 900, 120).costUsd,
      cached: false,
      model: 'gpt-5.4',
      promptVersion: 'betaReader.v1'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'strong', json: true, maxTokens: 1_200 })
    expect('temperature' in request).toBe(false)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'betaReader',
      tier: 'strong',
      promptVersion: 'betaReader.v1',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads every earlier scene through its stored summary, in order, and the scene itself in full', async () => {
    await read()
    const user = sent().user
    expect(user).toContain(
      'Scenes read so far, in order (summaries):\n' +
        `[1] Chapter 1 › Scene 1\n${summaryRow('', 0).summary}\n- The ledger is a copy (0).`
    )
    expect(user).toContain(`[2] Chapter 2 › Scene 1\n${summaryRow('', 1).summary}`)
    expect(user).toContain(`[3] Chapter 3 › Scene 1 (this scene, full text):\n"""\n${SCENE}\n"""`)
    expect(user.endsWith('Report as the reader.')).toBe(true)
    // The reader knows only what the page said: no voice block, no story bible, no brief.
    expect(sent().system).not.toContain("Match the author's voice:")
    expect(user).not.toContain('Scene brief')
  })

  it('counts the earlier scenes with no stored summary instead of sending their text', async () => {
    const documents = manuscriptDocuments(db)
    const fourth = documents[3]?.id ?? ''
    saveDocument(db, fourth, doc(SCENE))
    const result = await runBetaReader(db, deps, { nodeId: fourth })
    expect(result.missing).toBe(1)
    // Chapter 3's scene has no summary, so it is counted and left out; the current scene is
    // Part 2's first, which is why the chapter names repeat.
    expect(result.scenes.map((s) => s.title)).toEqual([
      'Chapter 1 › Scene 1',
      'Chapter 2 › Scene 1',
      'Chapter 1 › Scene 1'
    ])
    expect(sent().user).not.toContain('[3] Chapter 3 › Scene 1\n')
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Beta reader needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, betaReader: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Beta reader is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node, a folder, a short scene, and a document outside the manuscript', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    const outside = await failure({ nodeId: frontDoc })
    expect(outside.code).toBe('VALIDATION')
    expect(outside.message).toContain('The beta reader reads manuscript scenes')
    saveDocument(db, scene, doc('x'.repeat(BETA_READER_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${BETA_READER_TEXT_MIN} characters`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('head-truncates a long scene to the character budget and reports it as truncated', async () => {
    const long = `${SCENE} `.repeat(400)
    saveDocument(db, scene, doc(long))
    answers([item()])
    const result = await read()
    expect(result.truncated).toBe(true)
    const scenePart = sent().user.split('(this scene, full text):\n"""\n')[1]?.split('\n"""')[0] ?? ''
    expect(scenePart).toHaveLength(BETA_READER_SCENE_CHAR_BUDGET + 1)
  })

  it('sends the honesty line the project is set to, shared with the editor’s notes', async () => {
    const settings = defaultAiSettings()
    setAiSettings(db, { ...settings, dial: 1, critique: { honesty: 'brutal' } })
    await read()
    const system = sent().system
    expect(system.startsWith('You are the beta-reader feature inside a novel-writing app.')).toBe(
      true
    )
    expect(system).toContain('Be brutal:')
    expect(system).not.toContain('Be specific and direct:')
  })

  it('answers the same read from the cache, and misses it when a summary, the scene, or the honesty changes', async () => {
    await read()
    await read()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    upsertSummary(db, { ...summaryRow(earlier[0]!, 0), contentHash: 'hash-rewritten' })
    answers([item()])
    await read()
    expect(complete).toHaveBeenCalledTimes(2)
    const settings = defaultAiSettings()
    setAiSettings(db, { ...settings, dial: 1, critique: { honesty: 'encouraging' } })
    answers([item()])
    await read()
    expect(complete).toHaveBeenCalledTimes(3)
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
    const pending = read({ requestId: 'br-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('br-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
  })
})

describe('runBetaReader citations (F-14.11)', () => {
  it('keeps an item that quotes an earlier scene’s summary and drops one that quotes the wrong scene', async () => {
    complete.mockReset()
    answers([
      item({ category: 'expects', scene: 1, quote: SUMMARY_QUOTE }),
      // The quote is in scene 3, but the item names scene 1: uncited where it claims to be.
      item({ scene: 1 }),
      item({ category: 'confusion', scene: 9 })
    ])
    const result = await read()
    expect(result.items).toEqual([
      { category: 'expects', scene: 1, quote: SUMMARY_QUOTE, note: NOTE }
    ])
    expect(result.dropped).toBe(2)
  })

  it('answers PROVIDER when the model does not reply in the expected shape', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'I read it all!',
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 5 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    complete.mockResolvedValueOnce({
      text: '{"verdict":"good"}',
      model: 'gpt-5.4',
      usage: { inputTokens: 900, outputTokens: 5 }
    })
    expect((await failure({ note: 'again' })).code).toBe('PROVIDER')
  })
})

describe('runBetaReader regenerate (F-14.5)', () => {
  it('sends betaReaderRegen.v1 with the note clause and misses the cache on the note and the predecessor', async () => {
    await read()
    expect(complete).toHaveBeenCalledTimes(1)
    const note = 'Less about what you expect, more about where you got lost.'
    answers([item()])
    const again = await read({ note, regeneratedFrom: 'p-1' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(sent(1).user).toContain(`The writer asked for a different read and said: "${note}".`)
    expect(sent(1).system).toBe(sent(0).system)
    expect(again.promptVersion).toBe('betaReaderRegen.v1')
    expect(ledger.map((row) => row.promptVersion)).toEqual(['betaReader.v1', 'betaReaderRegen.v1'])
    // A predecessor with no note is its own request; a blank note with no predecessor is not one at all.
    answers([item()])
    await read({ regeneratedFrom: 'p-2' })
    expect(complete).toHaveBeenCalledTimes(3)
    const plain = await read({ note: '   ' })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(plain.promptVersion).toBe('betaReader.v1')
  })
})

describe('parseBetaReaderAnswer (F-14.11)', () => {
  const TEXTS = ['Mara finds the ledger.\nThe ledger is a copy.', SCENE]
  const parse = (items: ModelItem[]): ReturnType<typeof parseBetaReaderAnswer> =>
    parseBetaReaderAnswer(JSON.stringify({ items }), TEXTS)
  const here = (over: ModelItem = {}): ModelItem => item({ scene: 2, ...over })

  it('drops and counts an item with an unknown category, a scene out of range, or a blank quote or note', () => {
    const result = parse([
      here({ category: 'vibes' }),
      here({ scene: 0 }),
      here({ scene: 3 }),
      here({ scene: 2.5 }),
      here({ quote: '   ' }),
      here({ note: '' }),
      here({ quote: 42 }),
      here()
    ])
    expect(result.items).toHaveLength(1)
    expect(result.dropped).toBe(7)
  })

  it('trims and caps the strings and matches the quote through the shared normalization', () => {
    const wrapped = 'The rope hung slack in the\n  water'
    const result = parse([
      here({ quote: `  ${wrapped}  `, note: 'n'.repeat(BETA_READER_NOTE_MAX + 20) })
    ])
    expect(result.items[0]?.quote).toBe(wrapped)
    expect(result.items[0]?.note).toHaveLength(BETA_READER_NOTE_MAX)
    expect(parse([here({ quote: 'x'.repeat(BETA_READER_QUOTE_MAX + 10) })]).dropped).toBe(1)
  })

  it('keeps the first item per scene and quote, and the same quote from another scene', () => {
    expect(parse([here(), here({ note: 'Again.' })]).items).toHaveLength(1)
    const both = parse([
      here({ quote: 'The ledger is a copy.', scene: 1 }),
      here({ quote: 'The ledger is a copy.', scene: 1 })
    ])
    expect(both.items).toHaveLength(1)
    expect(both.dropped).toBe(0)
  })

  it('caps the list at the item maximum', () => {
    const many = Array.from({ length: BETA_READER_MAX_ITEMS + 3 }, (_, i) =>
      here({ quote: SCENE.slice(i, 60 + i) })
    )
    expect(parse(many).items).toHaveLength(BETA_READER_MAX_ITEMS)
  })

  it('refuses an answer that is not JSON or not { items: [...] } at all', () => {
    expect(() => parseBetaReaderAnswer('nope', TEXTS)).toThrowError(/expected format/)
    expect(() => parseBetaReaderAnswer('{"verdict":"good"}', TEXTS)).toThrowError(/expected format/)
  })
})

describe('fitReadThrough (F-14.11, token rule 8)', () => {
  const scenes = Array.from({ length: 10 }, (_, index) => `summary ${index} `.repeat(40))
  const build = (sceneText: string, kept: string[]): { role: 'user'; content: string }[] => [
    { role: 'user', content: [...kept, sceneText].join('\n') }
  ]

  it('sends the whole read-through untouched when it fits', () => {
    expect(fitReadThrough(SCENE, scenes, inputBudget('betaReader'), build)).toEqual({
      sceneText: SCENE,
      scenes,
      truncated: false,
      skipped: 0
    })
  })

  it('shrinks the scene before it drops a scene the reader read', () => {
    const fit = fitReadThrough('x'.repeat(BETA_READER_SCENE_CHAR_BUDGET * 2), scenes, 3_000, build)
    expect(fit.truncated).toBe(true)
    expect(fit.skipped).toBe(0)
    expect(fit.scenes).toEqual(scenes)
    expect(estimateTokens(fit.sceneText)).toBeLessThanOrEqual(3_000)
    expect(fit.sceneText.endsWith('…')).toBe(true)
  })

  it('then drops the farthest earlier scenes, nearest last, and counts them', () => {
    const fit = fitReadThrough('x'.repeat(BETA_READER_SCENE_CHAR_BUDGET), scenes, 1_600, build)
    expect(fit.sceneText).toHaveLength(BETA_READER_SCENE_CHAR_FLOOR + 1)
    expect(fit.skipped).toBeGreaterThan(0)
    expect(fit.scenes).toEqual(scenes.slice(fit.skipped))
    expect(estimateTokens(build(fit.sceneText, fit.scenes)[0]!.content)).toBeLessThanOrEqual(1_600)
  })

  it('stops with nothing left to drop rather than cutting the scene away entirely', () => {
    const fit = fitReadThrough('x'.repeat(10_000), scenes, 1, build)
    expect(fit.sceneText).toHaveLength(BETA_READER_SCENE_CHAR_FLOOR + 1)
    expect(fit.scenes).toEqual([])
    expect(fit.skipped).toBe(scenes.length)
    expect(fit.truncated).toBe(true)
  })
})
