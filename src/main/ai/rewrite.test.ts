import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { setAiSettings, setAuthorRules } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import { REGEN_CLAUSE_PREFIX } from './prompts/ghostTextRegen.v1'
import {
  AiCancelledError,
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk
} from './providers/types'
import type { AiRequestDeps } from './request'
import { runRewrite, type RewriteInput } from './rewrite'
import type { UsageEntry } from './usageStore'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'

const NOW = new Date(2026, 8, 15, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>
type Stream = (request: CompletionRequest) => AsyncIterable<StreamChunk>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let stream: ReturnType<typeof vi.fn<Stream>>
let chunks: (StreamChunk | Error)[]
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
let folder: string
let dailyCapUsd: number

/** The passage the author selected: long enough for `REWRITE_TEXT_MIN`. */
const PASSAGE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BEFORE = 'She set the lantern down on the post and waited.'
const AFTER = 'She did not wait to see his face.'

/** One paragraph of third-person past narration with four dialogue tags; six of them make a strong profile. */
const VOICE_PARAGRAPH =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired, and he was ' +
  'tired too. They walked to the door and she pulled it open. "The river is rising," she said. ' +
  '"Then we wait," he said.'
/** Third person, past: passes every fragment check. */
const CLEAN =
  'She turned back to the ridge and he followed, and they said nothing until the door had closed.'
/** Five present markers and five first-person pronouns: trips tense first. */
const OFF_VOICE =
  'I am lost and I know we are done, and it is late, and my hands are cold, and I am tired.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next streamed answer, as one delta with the usage chunk the adapter sends last. */
function streams(text: string): void {
  chunks = [{ delta: text, usage: { inputTokens: 90, outputTokens: 8 } }]
}

/** The next non-streamed answers (the fidelity regenerate completes as a whole). */
function answers(...texts: string[]): void {
  for (const text of texts) {
    complete.mockResolvedValueOnce({
      text,
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
  }
}

const input = (over: Partial<RewriteInput> = {}): RewriteInput => ({
  nodeId: scene,
  text: PASSAGE,
  before: '',
  after: '',
  ...over
})

const rewrite = (
  over: Partial<RewriteInput> = {},
  onDelta: (delta: string) => void = () => {}
): ReturnType<typeof runRewrite> => runRewrite(db, deps, input(over), onDelta)

async function failure(
  over: Partial<RewriteInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await rewrite(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

/** A manuscript strong enough for the tense and person rules. */
const strongProfile = (): void => {
  saveDocument(db, scene, doc(Array(6).fill(VOICE_PARAGRAPH).join(' ')))
}

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
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-rewrite-'))
  session = createProject(projectFolderFor(tmp, 'Rewrite'), 'Rewrite', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(PASSAGE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 2 })
  complete = vi.fn<Complete>()
  streams(CLEAN)
  stream = vi.fn<Stream>(async function* () {
    for (const chunk of chunks) {
      if (chunk instanceof Error) throw chunk
      yield chunk
    }
  })
  ledger = []
  dailyCapUsd = defaultAiUsageState().dailyCapUsd
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream,
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

describe('runRewrite (F-14.10)', () => {
  it('streams the draft through onDelta, resolves the post-processed passage, and logs one fast-tier rewrite.v1 row with no temperature', async () => {
    chunks = [
      { delta: '"She turned back to the ridge ' },
      { delta: 'and he followed."', usage: { inputTokens: 90, outputTokens: 8 } }
    ]
    const seen: string[] = []
    const result = await rewrite({}, (delta) => void seen.push(delta))
    expect(seen).toEqual(['"She turned back to the ridge ', 'and he followed."'])
    expect(result).toEqual({
      text: 'She turned back to the ridge and he followed.',
      usage: { inputTokens: 90, outputTokens: 8 },
      costUsd: priceFor('gpt-5.4-mini', 90, 8).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'rewrite.v1',
      flagged: false,
      violation: null
    })
    expect(complete).not.toHaveBeenCalled()
    const request = stream.mock.calls[0]![0]
    expect(request).toMatchObject({
      tier: 'fast',
      maxTokens: Math.ceil((PASSAGE.length / 4) * 1.5) + 40
    })
    expect('temperature' in request).toBe(false)
    expect(request.json).toBeUndefined()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'rewrite',
      tier: 'fast',
      promptVersion: 'rewrite.v1',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sends the voice block and the scene line system-side and the context each side of the passage in the user turn', async () => {
    strongProfile()
    setSceneMeta(db, scene, { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF })
    await rewrite({ before: BEFORE, after: AFTER })
    const messages = stream.mock.calls[0]![0].messages
    expect(messages).toHaveLength(2)
    const system = messages[0]?.content ?? ''
    expect(system.startsWith('You are the rewrite feature inside a novel-writing app.')).toBe(true)
    expect(system).toContain("Match the author's voice:")
    expect(system).toContain('Scene: location Ferry landing, POV Mara, timeline —.')
    expect(messages[1]?.content).toBe(
      `Text before:\n"""\n${BEFORE}\n"""\n\nText after:\n"""\n${AFTER}\n"""\n\n` +
        `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\nRewrite the passage.`
    )
  })

  it('sends no voice block and no scene line for a fresh project with no metadata', async () => {
    const system = (await rewrite().then(() => stream.mock.calls[0]![0].messages[0]?.content)) ?? ''
    expect(system).not.toContain("Match the author's voice:")
    expect(system).not.toContain('Scene: location')
  })

  it('answers the same passage from the cache and misses it when the passage, the context, or the voice version change', async () => {
    await rewrite()
    await rewrite()
    expect(stream).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    await rewrite({ before: BEFORE })
    expect(stream).toHaveBeenCalledTimes(2)
    await rewrite({ after: AFTER })
    expect(stream).toHaveBeenCalledTimes(3)
    await rewrite({ text: `${PASSAGE} And then the rain.` })
    expect(stream).toHaveBeenCalledTimes(4)
    bumpVoiceVersion()
    await rewrite()
    expect(stream).toHaveBeenCalledTimes(5)
  })

  it('refuses with DISABLED when the dial is below Suggest or the feature is off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Rewrite in my voice needs the AI dial at Suggest or higher (it is at Ask).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 2, features: { ...on.features, rewrite: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Rewrite in my voice is turned off for this project.'
    })
    expect(stream).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node with NOT_FOUND, a folder with VALIDATION, and a passage or context window outside the shared limits with VALIDATION', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    expect((await failure({ text: 'x'.repeat(REWRITE_TEXT_MIN - 1) })).code).toBe('VALIDATION')
    expect((await failure({ text: 'x'.repeat(REWRITE_TEXT_MAX + 1) })).code).toBe('VALIDATION')
    expect((await failure({ before: 'b'.repeat(REWRITE_CONTEXT_CHARS + 1) })).code).toBe(
      'VALIDATION'
    )
    expect((await failure({ after: 'a'.repeat(REWRITE_CONTEXT_CHARS + 1) })).code).toBe(
      'VALIDATION'
    )
    expect(stream).not.toHaveBeenCalled()
  })

  it('lets a budget refusal (the daily cap) and a provider error mid-stream propagate, logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    chunks = [new AiRateLimitError('Slow down.')]
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
  })

  it('hands the requestId to the stream as its signal, and a cancel mid-stream rejects with CANCELLED after the deltas shown (F-5.10)', async () => {
    stream.mockImplementationOnce(async function* (request) {
      yield { delta: 'Half' }
      await untilCancelled(request)
    })
    const seen: string[] = []
    const pending = rewrite({ requestId: 'r-1' }, (delta) => void seen.push(delta))
    await vi.waitFor(() => expect(seen).toEqual(['Half']))
    expect(stream.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('r-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
    await rewrite()
    expect('signal' in stream.mock.calls[1]![0]).toBe(false)
  })
})

describe('runRewrite fidelity check (F-14.7)', () => {
  it('regenerates an off-voice draft once through rewriteRegen.v1, unstreamed, with the violation named, and shows the clean second draft with both calls summed', async () => {
    strongProfile()
    streams(OFF_VOICE)
    answers(CLEAN)
    const seen: string[] = []
    const result = await rewrite({}, (delta) => void seen.push(delta))
    expect(seen).toEqual([OFF_VOICE])
    expect(stream).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    const second = complete.mock.calls[0]![0]
    expect(second.messages[0]?.content).toContain(
      `${REGEN_CLAUSE_PREFIX} switches to present tense. Rewrite it again, keeping the manuscript's voice.`
    )
    expect(second.messages.slice(1)).toEqual(stream.mock.calls[0]![0].messages.slice(1))
    expect(ledger.map((row) => row.promptVersion)).toEqual(['rewrite.v1', 'rewriteRegen.v1'])
    expect(ledger[0]!.contextHash).not.toBe(ledger[1]!.contextHash)
    expect(result).toEqual({
      text: CLEAN,
      usage: { inputTokens: 210, outputTokens: 20 },
      costUsd: priceFor('gpt-5.4-mini', 90, 8).costUsd + priceFor('gpt-5.4-mini', 120, 12).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'rewriteRegen.v1',
      flagged: false,
      violation: null
    })
  })

  it('shows the second draft flagged when it is off-voice too, and falls back to the first, flagged, when the regenerate fails or comes back empty', async () => {
    strongProfile()
    streams(OFF_VOICE)
    answers(OFF_VOICE)
    expect(await rewrite()).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      violation: 'switches to present tense',
      promptVersion: 'rewriteRegen.v1'
    })
    // A different passage each time, so nothing answers from the cache.
    streams(OFF_VOICE)
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect(await rewrite({ text: `${PASSAGE} Again.` })).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      violation: 'switches to present tense',
      promptVersion: 'rewrite.v1',
      usage: { inputTokens: 90, outputTokens: 8 }
    })
    streams(OFF_VOICE)
    answers('""')
    expect(await rewrite({ text: `${PASSAGE} Once more.` })).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      promptVersion: 'rewrite.v1',
      usage: { inputTokens: 210, outputTokens: 20 }
    })
  })

  it('regenerates a draft that uses a banned phrase, naming it, on a fresh project (F-14.2)', async () => {
    const banned = 'She turned back to the ridge and did not delve into it again.'
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    streams(banned)
    answers(CLEAN)
    const result = await rewrite()
    expect(stream.mock.calls[0]![0].messages[0]?.content).toContain(
      'Never use these phrases: delve.'
    )
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0].messages[0]?.content).toContain(
      `${REGEN_CLAUSE_PREFIX} uses the phrase \u201Cdelve\u201D, which the author has banned.`
    )
    expect(result).toMatchObject({ text: CLEAN, flagged: false, violation: null })
  })

  it('never regenerates on a stylometric signal for a project with neither rules nor exemplars', async () => {
    streams(OFF_VOICE)
    const result = await rewrite()
    expect(complete).not.toHaveBeenCalled()
    expect(result).toMatchObject({ text: OFF_VOICE, flagged: false, violation: null })
  })

  it('registers the regenerate under id:regen, and a cancel during it propagates as CANCELLED instead of falling back (F-5.10)', async () => {
    strongProfile()
    streams(OFF_VOICE)
    complete.mockImplementationOnce(untilCancelled)
    const pending = rewrite({ requestId: 'r-2' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(cancelInflight('r-2')).toBe(false) // the streamed call is released
    expect(cancelInflight('r-2:regen')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(1)
    expect(inflightCount()).toBe(0)
  })
})

describe('runRewrite author regenerate (F-14.5)', () => {
  it('sends rewriteRegen.v1 from the start with the note clause, and misses the cache on the note and the predecessor', async () => {
    await rewrite()
    expect(stream).toHaveBeenCalledTimes(1)
    const note = 'Less lightning, more of the rope.'
    const result = await rewrite({ note, regeneratedFrom: 'p-1' })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1]![0].messages[0]?.content).toContain(
      `The writer asked for a different rewrite and said: "${note}".`
    )
    expect(result.promptVersion).toBe('rewriteRegen.v1')
    expect(ledger.map((row) => row.promptVersion)).toEqual(['rewrite.v1', 'rewriteRegen.v1'])
    // A different note, and a predecessor with no note, are each their own request.
    await rewrite({ note: 'Colder.', regeneratedFrom: 'p-1' })
    expect(stream).toHaveBeenCalledTimes(3)
    await rewrite({ regeneratedFrom: 'p-2' })
    expect(stream).toHaveBeenCalledTimes(4)
    // A blank note with no predecessor is no regenerate at all: the plain prompt, cached.
    const plain = await rewrite({ note: '   ' })
    expect(stream).toHaveBeenCalledTimes(4)
    expect(plain.promptVersion).toBe('rewrite.v1')
  })

  it('carries the note clause and the violation clause together when the fidelity check fires on a regenerate', async () => {
    strongProfile()
    streams(OFF_VOICE)
    answers(CLEAN)
    const note = 'Colder, and keep the bell.'
    await rewrite({ note })
    const system = complete.mock.calls[0]![0].messages[0]?.content ?? ''
    expect(system).toContain(`The writer asked for a different rewrite and said: "${note}". `)
    expect(system.endsWith("Rewrite it again, keeping the manuscript's voice.")).toBe(true)
    expect(ledger.map((row) => row.promptVersion)).toEqual(['rewriteRegen.v1', 'rewriteRegen.v1'])
  })
})
