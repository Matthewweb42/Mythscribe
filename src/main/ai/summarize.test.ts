import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { emptySceneMeta } from '@shared/sceneMeta'
import {
  SUMMARY_CHARACTER_MAX,
  SUMMARY_CHARACTERS_MAX,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TEXT_MIN
} from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { getSummary, upsertSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createTag } from '../tag/tagStore'
import { node } from '../db/schema'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import {
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import {
  parseSummaryAnswer,
  staleSummaryNodeIds,
  summarizeScene,
  summarySource,
  type SummarizeSceneInput
} from './summarize'
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

/** The scene summarised: comfortably over `SUMMARY_TEXT_MIN`. */
const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
  '"You came alone," a voice said behind her. She did not turn. "You said to."'

const ANSWER = {
  summary: 'Mara waited alone at the ferry landing until Tomas came out of the dark.',
  keyPoints: ['The bell has no clapper', 'Tomas arrives empty-handed'],
  characters: ['Mara', 'Tomas']
}

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next answers, as the JSON the prompt asks for. */
function answers(...replies: unknown[]): void {
  for (const reply of replies) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify(reply),
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 90 }
    })
  }
}

const summarize = (over: Partial<SummarizeSceneInput> = {}): ReturnType<typeof summarizeScene> =>
  summarizeScene(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<SummarizeSceneInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await summarize(over)
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

/** A front-matter document, to prove only the manuscript is summarised. */
function matterDocument(): string {
  const front = listNodes(db).find((row) => row.sectionType === 'front')
  if (!front) throw new Error('no front section')
  const now = NOW.toISOString()
  db.insert(node)
    .values({
      id: 'matter-1',
      parentId: front.id,
      kind: 'document',
      title: 'Dedication',
      position: 0,
      created: now,
      modified: now
    })
    .run()
  saveDocument(db, 'matter-1', doc(SCENE))
  return 'matter-1'
}

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-summary-'))
  session = createProject(projectFolderFor(tmp, 'Summary'), 'Summary', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers(ANSWER)
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

describe('summarizeScene (F-5.6)', () => {
  it('sends the scene as JSON to the fast tier under summary.v1 and stores the row', async () => {
    const result = await summarize()
    expect(result).toEqual({
      summary: {
        ...ANSWER,
        nodeId: scene,
        contentHash: summarySource(db, scene)?.contentHash,
        promptVersion: 'summary.v1',
        model: 'gpt-5.4-mini',
        truncated: false,
        createdAt: NOW.toISOString()
      },
      usage: { inputTokens: 600, outputTokens: 90 },
      costUsd: priceFor('gpt-5.4-mini', 600, 90).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'summary.v1'
    })
    expect(getSummary(db, scene)).toEqual(result.summary)
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 300 })
    expect(
      sent().system.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
    expect(sent().user).toBe(`Scene text:\n"""\n${SCENE}\n"""\n\nSummarize the scene.`)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'summary',
      tier: 'fast',
      promptVersion: 'summary.v1',
      cached: false
    })
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Scene summaries needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 3, features: { ...on.features, summary: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Scene summaries is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('summarises manuscript documents only: a folder, front matter, and an unknown id are VALIDATION', async () => {
    for (const nodeId of [folder, matterDocument(), 'nope']) {
      expect((await failure({ nodeId })).code).toBe('VALIDATION')
      expect(summarySource(db, nodeId)).toBeNull()
    }
    expect(complete).not.toHaveBeenCalled()
  })

  it('drops the stored row when the scene falls back under the minimum, and refuses', async () => {
    await summarize()
    expect(getSummary(db, scene)).not.toBeNull()
    saveDocument(db, scene, doc('x'.repeat(SUMMARY_TEXT_MIN - 1)))
    const short = await failure()
    expect(short.code).toBe('VALIDATION')
    expect(short.message).toContain(`${SUMMARY_TEXT_MIN} characters`)
    expect(getSummary(db, scene)).toBeNull()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('answers an unchanged scene from the stored row without a request at all', async () => {
    const first = await summarize()
    const again = await summarize()
    expect(again).toEqual({
      summary: first.summary,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: true,
      model: 'gpt-5.4-mini',
      promptVersion: 'summary.v1'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    // No request, so no ledger row either: nothing was spent and nothing was sent.
    expect(ledger).toHaveLength(1)
  })

  it('runs again when the text, the metadata, or the character bank change', async () => {
    await summarize()
    saveDocument(db, scene, doc(`${SCENE} The lantern went out.`))
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(2)
    setSceneMeta(db, scene, { ...emptySceneMeta(), pov: 'Mara' })
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(sent(2).system).toContain('Scene: location —, POV Mara, timeline —.')
    createTag(db, { name: 'tomas', category: 'character', color: '#aabbcc' })
    answers(ANSWER)
    await summarize()
    expect(complete).toHaveBeenCalledTimes(4)
    expect(sent(3).system).toContain('Characters in the story bible: tomas.')
  })

  it('head-truncates a long scene to the character budget and records it as truncated', async () => {
    saveDocument(db, scene, doc(`${SCENE} `.repeat(400)))
    answers(ANSWER)
    const result = await summarize()
    expect(result.summary.truncated).toBe(true)
    const scenePart = sent().user.split('Scene text:\n"""\n')[1]?.split('\n"""')[0] ?? ''
    expect(scenePart).toHaveLength(SUMMARY_SCENE_CHAR_BUDGET + 1)
  })

  it('sends only the character tags, never the whole bank', async () => {
    createTag(db, { name: 'mara', category: 'character', color: '#aabbcc' })
    createTag(db, { name: 'ferry-landing', category: 'setting', color: '#aabbcc' })
    await summarize()
    expect(sent().system).toContain('Characters in the story bible: mara.')
    expect(sent().system).not.toContain('ferry-landing')
  })

  it('lets a budget refusal and a provider error propagate, storing and logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    complete.mockReset()
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
    expect(getSummary(db, scene)).toBeNull()
  })

  it('reports an answer that is not JSON, or carries no summary, as a PROVIDER failure', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'Mara waits at the landing.',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 90 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    answers({ keyPoints: ['no summary line'] })
    expect((await failure()).code).toBe('PROVIDER')
    expect(getSummary(db, scene)).toBeNull()
  })
})

describe('parseSummaryAnswer (F-5.6)', () => {
  it('trims the summary and cuts it to the stored cap', () => {
    const long = 's'.repeat(SUMMARY_MAX_CHARS + 50)
    expect(parseSummaryAnswer(JSON.stringify({ ...ANSWER, summary: `  ${long}  ` })).summary).toBe(
      's'.repeat(SUMMARY_MAX_CHARS)
    )
  })

  it('refuses an answer with no usable summary, whatever else it carries', () => {
    for (const summary of ['', '   ', 7, null, undefined]) {
      expect(() => parseSummaryAnswer(JSON.stringify({ ...ANSWER, summary }))).toThrow()
    }
    expect(() => parseSummaryAnswer('not json')).toThrow()
    expect(() => parseSummaryAnswer(JSON.stringify(['a', 'b']))).toThrow()
  })

  it('drops non-strings, blanks, and case-insensitive duplicates from the two lists', () => {
    const parsed = parseSummaryAnswer(
      JSON.stringify({
        ...ANSWER,
        keyPoints: ['  The bell has no clapper  ', 7, '', 'the bell has no clapper', null],
        characters: ['Mara', 'mara', { name: 'Tomas' }, 'Tomas']
      })
    )
    expect(parsed.keyPoints).toEqual(['The bell has no clapper'])
    expect(parsed.characters).toEqual(['Mara', 'Tomas'])
  })

  it('caps each entry and how many of them are kept', () => {
    const parsed = parseSummaryAnswer(
      JSON.stringify({
        ...ANSWER,
        keyPoints: Array.from(
          { length: SUMMARY_KEY_POINTS_MAX + 3 },
          (_, i) => `${i} ${'k'.repeat(SUMMARY_KEY_POINT_MAX + 20)}`
        ),
        characters: Array.from(
          { length: SUMMARY_CHARACTERS_MAX + 3 },
          (_, i) => `${i} ${'c'.repeat(SUMMARY_CHARACTER_MAX + 20)}`
        )
      })
    )
    expect(parsed.keyPoints).toHaveLength(SUMMARY_KEY_POINTS_MAX)
    expect(parsed.characters).toHaveLength(SUMMARY_CHARACTERS_MAX)
    expect(parsed.keyPoints[0]).toHaveLength(SUMMARY_KEY_POINT_MAX)
    expect(parsed.characters[0]).toHaveLength(SUMMARY_CHARACTER_MAX)
  })

  it('reads a missing list as none, and ignores anything the prompt did not ask for', () => {
    expect(parseSummaryAnswer(JSON.stringify({ summary: 'Mara waits.', extra: 1 }))).toEqual({
      summary: 'Mara waits.',
      keyPoints: [],
      characters: []
    })
  })
})

describe('staleSummaryNodeIds (F-5.13)', () => {
  /** A second manuscript scene right after the seeded one, with the text it is given. */
  function secondScene(text: string): string {
    const now = NOW.toISOString()
    const first = listNodes(db).find((row) => row.id === scene)
    if (!first) throw new Error('no seeded scene')
    db.insert(node)
      .values({
        id: 'scene-2',
        parentId: first.parentId,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: 'Scene 2',
        position: first.position + 1,
        created: now,
        modified: now
      })
      .run()
    saveDocument(db, 'scene-2', doc(text))
    return 'scene-2'
  }

  it('lists a scene with no summary and skips the ones too short to have one', () => {
    const second = secondScene('Too short to summarise.')
    expect(staleSummaryNodeIds(db)).toEqual([scene])
    expect(second).toBe('scene-2')
  })

  it('skips a scene whose stored summary is still current, and the front matter', async () => {
    // A front-matter document is long enough but is not in the manuscript: never summarised.
    matterDocument()
    await summarize()
    expect(staleSummaryNodeIds(db)).toEqual([])
  })

  it('lists a scene again once its text has changed', async () => {
    await summarize()
    expect(staleSummaryNodeIds(db)).toEqual([])
    saveDocument(db, scene, doc(`${SCENE} She left the lantern burning on the post.`))
    expect(staleSummaryNodeIds(db)).toEqual([scene])
  })

  it('lists a scene whose summary came from an older prompt version', async () => {
    await summarize()
    const stored = getSummary(db, scene)
    if (!stored) throw new Error('no stored summary')
    upsertSummary(db, { ...stored, promptVersion: 'summary.v0' })
    expect(staleSummaryNodeIds(db)).toEqual([scene])
  })

  it('answers in reading order', () => {
    secondScene(SCENE)
    expect(staleSummaryNodeIds(db)).toEqual([scene, 'scene-2'])
  })
})
