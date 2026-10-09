import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { ImportDraft, ImportScene } from '@shared/import'
import {
  IMPORT_CHUNK_WORDS,
  STRUCTURE_REASON_MAX,
  STRUCTURE_TAGS_MAX,
  STRUCTURE_TITLE_MAX,
  type ImportDetectProgress
} from '@shared/importStructure'
import { JOB_MIN_INTERVAL_MS } from '@shared/jobs'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppError } from '../ipc/errors'
import { setAiSettings } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createTag, type TagDb } from '../tag/tagStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { detectImportStructure } from './importStructure'
import { cancelInflight, inflightCount, registerInflight, resetInflight } from './inflight'
import { proposalCount } from './proposalStore'
import {
  AiCancelledError,
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'
import { aiProposal } from '../db/schema'

const NOW = new Date(2026, 8, 22, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TagDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let provider: Provider | null

/** `complete` answers with this text; tests replace it per case. */
function answer(text: string): void {
  complete.mockResolvedValue({
    text,
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 40, outputTokens: 10 }
  })
}

/** `n` distinct words, so a paragraph's word count is exactly `n`. */
const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

const paragraph = (text: string): TiptapNodeT => ({
  type: 'paragraph',
  content: [{ type: 'text', text }]
})

const scene = (id: string, title: string, texts: string[]): ImportScene => ({
  id,
  title,
  excluded: false,
  tags: [],
  paragraphs: texts.map(paragraph)
})

/** One part whose scenes are grouped into chapters by name, in the order they are given. */
function draftOf(scenes: { chapter: string; scene: ImportScene }[]): ImportDraft {
  const chapters: ImportDraft['parts'][number]['chapters'] = []
  for (const entry of scenes) {
    const last = chapters[chapters.length - 1]
    if (last?.title === entry.chapter) last.scenes.push(entry.scene)
    else
      chapters.push({
        id: `c${chapters.length + 1}`,
        title: entry.chapter,
        excluded: false,
        placement: 'manuscript',
        scenes: [entry.scene]
      })
  }
  return {
    source: { name: 'book.md', format: 'md', words: 0, paragraphs: 0 },
    nextId: 1,
    parts: [{ id: 'p1', title: 'Book', excluded: false, chapters }]
  }
}

const DRAFT = draftOf([
  { chapter: 'Chapter One', scene: scene('s1', 'Scene 1', ['The bell rang.', 'She waited.']) },
  { chapter: 'Chapter One', scene: scene('s2', 'Scene 2', ['Morning came.']) },
  {
    chapter: 'Chapter Two',
    scene: scene('s3', 'Scene 3', ['She left the house.', 'The road was long.'])
  }
])

/** Every proposal's status, newest row last; the chunk rows are the only ones these tests make. */
const statuses = (): string[] =>
  db
    .select()
    .from(aiProposal)
    .all()
    .map((row) => row.status)

async function failure(draft = DRAFT): Promise<{ code: string; message: string }> {
  try {
    await detectImportStructure(db, deps, { draft, requestId: 'r-1' })
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/**
 * Lets pending promise chains run (up to 50 macrotask turns, none of them a faked timer) until
 * `done` holds; `() => false` just drains them.
 */
async function settled(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !done(); turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-structure-'))
  session = createProject(projectFolderFor(tmp, 'Imp'), 'Imp', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answer('{"breaks":[],"scenes":[]}')
  ledger = []
  provider = {
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
    dailyCap: { get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }), spend: () => {} },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('detectImportStructure (F-12.3)', () => {
  it('sends one chunk as importStructure.v1 in JSON mode on the fast tier and answers the totals', async () => {
    createTag(db, { name: 'Protagonist', category: 'character' })
    answer(
      '{"breaks":[{"before":1,"kind":"scene","reason":"time skip"}],' +
        '"scenes":[{"start":0,"title":"The Bell","tags":["protagonist"]}]}'
    )
    const result = await detectImportStructure(db, deps, { draft: DRAFT, requestId: 'r-1' })

    expect(result).toMatchObject({
      suggestions: {
        breaks: [{ before: 1, kind: 'scene', reason: 'time skip' }],
        scenes: [{ start: 0, title: 'The Bell', tags: ['protagonist'] }]
      },
      chunks: 1,
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: priceFor('gpt-5.4-mini', 40, 10).costUsd,
      model: 'gpt-5.4-mini',
      promptVersion: 'importStructure.v1'
    })
    expect(result.proposalIds).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.tier).toBe('fast')
    expect(request.json).toBe(true)
    expect(request.maxTokens).toBe(400)
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.content).toBe(
      'Tag bank: protagonist\n\nParagraphs:\n' +
        '— chapter starts here: "Chapter One" —\n' +
        '— scene starts here: "Scene 1" —\n' +
        '[0] The bell rang.\n' +
        '[1] She waited.\n' +
        '— scene starts here: "Scene 2" —\n' +
        '[2] Morning came.\n' +
        '— chapter starts here: "Chapter Two" —\n' +
        '— scene starts here: "Scene 3" —\n' +
        '[3] She left the house.\n' +
        '[4] The road was long.'
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'importStructure',
      promptVersion: 'importStructure.v1',
      cached: false
    })
  })

  it('keeps one pending proposal per chunk with the raw answer and nothing attached to a node', async () => {
    const text = '{"breaks":[],"scenes":[{"start":0,"title":"The Bell","tags":[]}]}'
    answer(text)
    const { proposalIds } = await detectImportStructure(db, deps, {
      draft: DRAFT,
      requestId: 'r-1'
    })
    const rows = db.select().from(aiProposal).all()
    expect(proposalCount(db)).toBe(1)
    expect(rows[0]).toMatchObject({
      id: proposalIds[0],
      feature: 'importStructure',
      nodeId: null,
      status: 'pending',
      content: text,
      cached: false,
      model: 'gpt-5.4-mini'
    })
  })

  it('drops a break at the first paragraph, one outside the chunk, and one the draft already has', async () => {
    answer(
      '{"breaks":[{"before":0,"kind":"scene","reason":"start"},' +
        '{"before":99,"kind":"scene","reason":"nowhere"},' +
        '{"before":2,"kind":"scene","reason":"already a scene"},' +
        '{"before":3,"kind":"chapter","reason":"already a chapter"},' +
        '{"before":2,"kind":"chapter","reason":"promote the scene"},' +
        '{"before":4,"kind":"scene","reason":"a real one"}],"scenes":[]}'
    )
    const { suggestions } = await detectImportStructure(db, deps, {
      draft: DRAFT,
      requestId: 'r-1'
    })
    expect(suggestions.breaks).toEqual([
      { before: 2, kind: 'chapter', reason: 'promote the scene' },
      { before: 4, kind: 'scene', reason: 'a real one' }
    ])
  })

  it('cuts a long reason and title, drops tags outside the bank, caps the tags, and drops an entry that changes nothing', async () => {
    createTag(db, { name: 'Protagonist', category: 'character' })
    for (let i = 0; i < STRUCTURE_TAGS_MAX + 2; i += 1) {
      createTag(db, { name: `tag-${i}`, category: 'custom' })
    }
    answer(
      JSON.stringify({
        breaks: [{ before: 4, kind: 'scene', reason: 'r'.repeat(STRUCTURE_REASON_MAX + 50) }],
        scenes: [
          {
            start: 0,
            title: 't'.repeat(STRUCTURE_TITLE_MAX + 50),
            tags: [
              'PROTAGONIST',
              'protagonist',
              'ghost-ship',
              ...Array.from({ length: STRUCTURE_TAGS_MAX + 2 }, (_, i) => `tag-${i}`)
            ]
          },
          { start: 2, title: '  ', tags: ['nothing-known'] }
        ]
      })
    )
    const { suggestions } = await detectImportStructure(db, deps, {
      draft: DRAFT,
      requestId: 'r-1'
    })
    expect(suggestions.breaks[0]?.reason).toHaveLength(STRUCTURE_REASON_MAX)
    expect(suggestions.scenes).toHaveLength(1)
    const [first] = suggestions.scenes
    expect(first?.title).toHaveLength(STRUCTURE_TITLE_MAX)
    expect(first?.tags).toHaveLength(STRUCTURE_TAGS_MAX)
    expect(first?.tags[0]).toBe('protagonist')
    expect(first?.tags).not.toContain('ghost-ship')
  })

  it('splits a long draft into chunks, spaces them, reports progress, and merges every chunk by global index', async () => {
    // Three paragraphs fill a chunk, so the nine below are three chunks of three.
    const long = words(Math.floor(IMPORT_CHUNK_WORDS / 3))
    const three = [long, long, long]
    const draft = draftOf([
      { chapter: 'One', scene: scene('s1', 'Scene 1', three) },
      { chapter: 'One', scene: scene('s2', 'Scene 2', three) },
      { chapter: 'Two', scene: scene('s3', 'Scene 1', three) }
    ])
    complete
      .mockResolvedValueOnce({
        text: '{"breaks":[{"before":1,"kind":"scene","reason":"one"}],"scenes":[]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 100, outputTokens: 20 }
      })
      .mockResolvedValueOnce({
        text: '{"breaks":[{"before":1,"kind":"scene","reason":"dropped: not in this chunk"}],"scenes":[{"start":4,"title":"Second","tags":[]}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 50, outputTokens: 5 }
      })
      .mockResolvedValueOnce({
        text: '{"breaks":[],"scenes":[{"start":7,"title":"Third","tags":[]}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 10, outputTokens: 1 }
      })
    const progress: ImportDetectProgress[] = []
    // The gap between chunks is a timer, so the test drives the timer instead of reading the
    // wall clock: `Date.now()` is not monotonic (WSL resyncs it under load; once it read -715
    // ms across this test), and a wall-clock check could not tell a gap from a slow machine.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pass = detectImportStructure(db, deps, {
      draft,
      requestId: 'r-1',
      onProgress: (entry) => void progress.push(entry)
    })
    // Two gaps between three chunks, each at the index queue's spacing: the next chunk is not
    // sent one millisecond early, and is sent when the gap ends.
    // (`vi.waitFor` would advance the fake clock itself, so the waits yield on `setImmediate`.)
    for (const done of [1, 2]) {
      await settled(() => progress.length === done)
      vi.advanceTimersByTime(JOB_MIN_INTERVAL_MS - 1)
      await settled(() => false)
      expect(complete).toHaveBeenCalledTimes(done)
      vi.advanceTimersByTime(1)
      await settled(() => complete.mock.calls.length === done + 1)
    }
    const result = await pass

    expect(complete).toHaveBeenCalledTimes(3)
    expect(result.chunks).toBe(3)
    expect(result.usage).toEqual({ inputTokens: 160, outputTokens: 26 })
    expect(result.suggestions.breaks).toEqual([{ before: 1, kind: 'scene', reason: 'one' }])
    expect(result.suggestions.scenes).toEqual([
      { start: 4, title: 'Second', tags: [] },
      { start: 7, title: 'Third', tags: [] }
    ])
    expect(result.proposalIds).toHaveLength(3)
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3])
    expect(progress[2]).toMatchObject({ total: 3, costUsd: result.costUsd })
  })

  it('stops at the chunk in flight when the pass is cancelled and reports CANCELLED', async () => {
    const long = words(IMPORT_CHUNK_WORDS)
    const draft = draftOf([{ chapter: 'One', scene: scene('s1', 'Scene 1', [long, long]) }])
    complete
      .mockResolvedValueOnce({
        text: '{"breaks":[],"scenes":[]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 10, outputTokens: 1 }
      })
      .mockImplementationOnce(
        (request) =>
          new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(new AiCancelledError('The request was stopped.')),
              { once: true }
            )
          })
      )
    const controller = registerInflight('r-1')
    const pending = detectImportStructure(db, deps, {
      draft,
      requestId: 'r-1',
      signal: controller.signal
    })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 3_000 })
    expect(cancelInflight('r-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    // The chunk that was answered stays in the ledger (it was paid for) and keeps its proposal,
    // settled `rejected` here because nothing it found reaches the draft and the failure
    // answers no ids for the renderer to close; the stopped chunk logged nothing.
    expect(ledger).toHaveLength(1)
    expect(proposalCount(db)).toBe(1)
    expect(statuses()).toEqual(['rejected'])
  })

  it('settles every chunk proposal rejected when the pass fails partway', async () => {
    const long = words(Math.floor(IMPORT_CHUNK_WORDS / 2))
    const draft = draftOf([
      { chapter: 'One', scene: scene('s1', 'Scene 1', [long, long]) },
      { chapter: 'Two', scene: scene('s2', 'Scene 1', [long, long]) }
    ])
    complete
      .mockResolvedValueOnce({
        text: '{"breaks":[],"scenes":[{"start":0,"title":"First","tags":[]}]}',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 10, outputTokens: 1 }
      })
      .mockResolvedValueOnce({
        text: 'Sure! The second chapter starts at paragraph 2.',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 10, outputTokens: 1 }
      })
    expect(await failure(draft)).toMatchObject({ code: 'PROVIDER' })
    expect(complete).toHaveBeenCalledTimes(2)
    // One proposal, for the chunk that answered: the malformed one was never shown.
    expect(statuses()).toEqual(['rejected'])
  })

  it('maps an answer that is not JSON, or not the shape the prompt asked for, to PROVIDER', async () => {
    const expected = {
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.'
    }
    answer('Sure! Chapter two starts at paragraph 3.')
    expect(await failure()).toEqual(expected)
    answer('{"scenes":[]}')
    expect(
      await failure(draftOf([{ chapter: 'A', scene: scene('s1', 'Scene 1', ['One.']) }]))
    ).toEqual(expected)
    answer('{"breaks":[{"before":"two","kind":"scene","reason":"x"}],"scenes":[]}')
    expect(
      await failure(draftOf([{ chapter: 'B', scene: scene('s1', 'Scene 1', ['Two.']) }]))
    ).toEqual(expected)
    answer('{"breaks":[{"before":1,"kind":"part","reason":"x"}],"scenes":[]}')
    expect(
      await failure(draftOf([{ chapter: 'C', scene: scene('s1', 'Scene 1', ['Three.']) }]))
    ).toEqual(expected)
  })

  it('refuses with DISABLED below the dial or with the toggle off, before touching the provider', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Import structure detection needs Use AI turned on (it is off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, {
      ...on,
      dial: 1,
      features: { ...on.features, importStructure: false }
    })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Import structure detection is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toEqual([])
  })

  it('passes the request path failures through (NO_KEY here) and leaves nothing in flight', async () => {
    provider = null
    expect(await failure()).toEqual({ code: 'NO_KEY', message: 'No API key is saved.' })
    expect(inflightCount()).toBe(0)
  })

  it('sends nothing for a draft with no paragraphs left and answers an empty pass', async () => {
    const empty = draftOf([{ chapter: 'One', scene: scene('s1', 'Scene 1', []) }])
    const result = await detectImportStructure(db, deps, { draft: empty, requestId: 'r-1' })
    expect(result).toEqual({
      suggestions: { breaks: [], scenes: [] },
      chunks: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      model: '',
      promptVersion: 'importStructure.v1',
      proposalIds: []
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers an identical chunk from the cache at no cost', async () => {
    answer('{"breaks":[],"scenes":[{"start":0,"title":"The Bell","tags":[]}]}')
    await detectImportStructure(db, deps, { draft: DRAFT, requestId: 'r-1' })
    const again = await detectImportStructure(db, deps, { draft: DRAFT, requestId: 'r-2' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(again).toMatchObject({
      costUsd: 0,
      suggestions: { scenes: [{ start: 0, title: 'The Bell', tags: [] }] }
    })
  })
})
