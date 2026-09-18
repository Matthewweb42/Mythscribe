import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import {
  BRIEF_SCENE_CHAR_BUDGET,
  BRIEF_TEXT_MIN,
  EMPTY_SCENE_BRIEF,
  SCENE_BRIEF_FIELD_MAX,
  emptySceneMeta
} from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { draftBrief, parseBriefAnswer, type DraftBriefInput } from './draftBrief'
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
let scene: string
let folder: string
let dailyCapUsd: number

/** The scene the brief is drafted from: over `BRIEF_TEXT_MIN`. */
const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'

const DRAFT = {
  goal: 'Mara wants to cross the river tonight.',
  conflict: 'The river is up and Tomas will not row.',
  turn: 'She decides to wait for morning.',
  beat: 'Dread giving way to resolve.',
  after: 'The crossing is off until dawn.'
}

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next answers, as the JSON the prompt asks for. */
function answers(...drafts: unknown[]): void {
  for (const draft of drafts) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(draft),
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 700, outputTokens: 80 }
    })
  }
}

const draft = (over: Partial<DraftBriefInput> = {}): ReturnType<typeof draftBrief> =>
  draftBrief(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<DraftBriefInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await draft(over)
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
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-brief-'))
  session = createProject(projectFolderFor(tmp, 'Brief'), 'Brief', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers(DRAFT)
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

describe('draftBrief (F-14.3)', () => {
  it('sends the scene as JSON to the fast tier under brief.v1 and answers the five lines', async () => {
    const result = await draft()
    expect(result).toEqual({
      brief: DRAFT,
      truncated: false,
      usage: { inputTokens: 700, outputTokens: 80 },
      costUsd: priceFor('gpt-5.4-mini', 700, 80).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'brief.v1'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 200 })
    expect('temperature' in request).toBe(false)
    expect(
      sent().system.startsWith('You are the scene-brief feature inside a novel-writing app.')
    ).toBe(true)
    expect(sent().user).toBe(`Scene text:\n"""\n${SCENE}\n"""\n\nDraft the brief.`)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'brief',
      tier: 'fast',
      promptVersion: 'brief.v1',
      cached: false
    })
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Scene brief drafts needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, brief: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Scene brief drafts is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node with NOT_FOUND, a folder with VALIDATION, and a scene under the minimum with VALIDATION', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    saveDocument(db, scene, doc('x'.repeat(BRIEF_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${BRIEF_TEXT_MIN} characters`)
    expect(complete).not.toHaveBeenCalled()
  })

  it('head-truncates a long scene to the character budget and reports it as truncated', async () => {
    const long = `${SCENE} `.repeat(400)
    saveDocument(db, scene, doc(long))
    answers(DRAFT)
    const result = await draft()
    expect(result.truncated).toBe(true)
    const scenePart = sent().user.split('Scene text:\n"""\n')[1]?.split('\n"""')[0] ?? ''
    expect(scenePart).toHaveLength(BRIEF_SCENE_CHAR_BUDGET + 1)
  })

  it('carries the metadata line when the scene has any, and nothing else of the project', async () => {
    expect(sent().system).toBe('')
    await draft()
    expect(sent().system).not.toContain('Scene: location')
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      location: 'Ferry landing',
      pov: 'Mara',
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Already written by the author.' }
    })
    answers(DRAFT)
    await draft()
    expect(sent(1).system).toContain('Scene: location Ferry landing, POV Mara, timeline —.')
    // The author's own brief never goes out: the draft is the model's reading of the scene.
    expect(`${sent(1).system}${sent(1).user}`).not.toContain('Already written by the author.')
    expect(`${sent(1).system}${sent(1).user}`).not.toContain("Match the author's voice:")
  })

  it('answers the same scene from the cache and misses it when the text or the metadata change', async () => {
    await draft()
    await draft()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    setSceneMeta(db, scene, { ...emptySceneMeta(), pov: 'Mara' })
    answers(DRAFT)
    await draft()
    expect(complete).toHaveBeenCalledTimes(2)
    saveDocument(db, scene, doc(`${SCENE} The lantern went out.`))
    answers(DRAFT)
    await draft()
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
    const pending = draft({ requestId: 'br-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('br-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
  })

  it('reports an answer that is not JSON, or not an object, as a PROVIDER failure', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'The scene is about a ferry.',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 700, outputTokens: 80 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    answers(['goal', 'conflict'])
    expect((await failure()).code).toBe('PROVIDER')
  })
})

describe('parseBriefAnswer (F-14.3)', () => {
  it('trims each line and cuts it to the field cap', () => {
    const long = 'g'.repeat(SCENE_BRIEF_FIELD_MAX + 50)
    expect(parseBriefAnswer(JSON.stringify({ ...DRAFT, goal: `  ${long}  ` })).goal).toBe(
      'g'.repeat(SCENE_BRIEF_FIELD_MAX)
    )
  })

  it('reads a missing or non-string field as the scene not showing it', () => {
    expect(
      parseBriefAnswer(JSON.stringify({ goal: 'She wants out.', conflict: 7, turn: null }))
    ).toEqual({ ...EMPTY_SCENE_BRIEF, goal: 'She wants out.' })
  })

  it('ignores anything the prompt did not ask for', () => {
    expect(parseBriefAnswer(JSON.stringify({ ...DRAFT, summary: 'A ferry scene.' }))).toEqual(DRAFT)
  })
})
