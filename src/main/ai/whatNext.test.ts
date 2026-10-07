import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { EMPTY_SCENE_BRIEF, emptySceneMeta } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  WHAT_NEXT_CHAR_BUDGET,
  WHAT_NEXT_DIRECTIONS,
  WHAT_NEXT_TEXT_MAX,
  WHAT_NEXT_TEXT_MIN,
  WHAT_NEXT_TITLE_MAX
} from '@shared/whatNext'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'
import { parseWhatNextAnswer, runWhatNext, tailText, type WhatNextInput } from './whatNext'

const NOW = new Date(2026, 9, 3, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string
let folder: string

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const DIRECTIONS = [
  { title: 'Tomas arrives late', text: 'He comes without the ledger and lies about why.' },
  { title: 'The bell rings', text: 'Someone upriver rings a bell that has no clapper.' },
  { title: 'Mara leaves', text: 'She gives up waiting and takes the ferry alone.' }
]

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** The next answer, as the JSON the prompt asks for. */
function answers(...sets: unknown[][]): void {
  for (const directions of sets) {
    complete.mockResolvedValueOnce({
      text: JSON.stringify({ directions }),
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 80 }
    })
  }
}

const whatNext = (over: Partial<WhatNextInput> = {}): ReturnType<typeof runWhatNext> =>
  runWhatNext(db, deps, { nodeId: scene, ...over })

async function failure(
  over: Partial<WhatNextInput> = {}
): Promise<{ code: string; message: string }> {
  try {
    await whatNext(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

const sent = (call = 0): { system: string; user: string } => ({
  system: complete.mock.calls[call]?.[0].messages[0]?.content ?? '',
  user: complete.mock.calls[call]?.[0].messages[1]?.content ?? ''
})

/** The text between the `Text so far` fences of a request. */
const sentText = (call = 0): string =>
  sent(call).user.split('Text so far:\n"""\n')[1]?.split('\n"""')[0] ?? ''

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-whatnext-'))
  session = createProject(projectFolderFor(tmp, 'What next'), 'What next', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  folder = listNodes(db).find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answers(DIRECTIONS)
  ledger = []
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
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
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

describe('runWhatNext (F-5.17)', () => {
  it('sends the scene as JSON to the fast tier under whatNext.v2 and answers the directions', async () => {
    const result = await whatNext()
    expect(result).toEqual({
      directions: DIRECTIONS,
      dropped: 0,
      truncated: false,
      usage: { inputTokens: 600, outputTokens: 80 },
      costUsd: priceFor('gpt-5.4-mini', 600, 80).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'whatNext.v2'
    })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 300 })
    expect('temperature' in request).toBe(false)
    expect(sentText()).toBe(SCENE)
    expect(
      sent().system.startsWith('You are the what-comes-next feature inside a novel-writing app.')
    ).toBe(true)
    // Directions are advice, not prose: no voice block goes out.
    expect(sent().system).not.toContain('Never use these phrases')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'whatNext',
      tier: 'fast',
      promptVersion: 'whatNext.v2'
    })
  })

  it('refuses with DISABLED below Ask or with the feature off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure({ nodeId: 'nope' })).toEqual({
      code: 'DISABLED',
      message: 'What comes next needs Use AI turned on (it is off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 1, features: { ...on.features, whatNext: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'What comes next is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses an unknown node, a folder, a document outside the manuscript, and short text', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
    expect((await failure({ nodeId: folder })).code).toBe('VALIDATION')
    const matter = listNodes(db).find(
      (row) => row.kind === 'document' && !manuscriptDocuments(db).some((d) => d.id === row.id)
    )
    if (matter !== undefined) {
      saveDocument(db, matter.id, doc(SCENE))
      expect(await failure({ nodeId: matter.id })).toEqual({
        code: 'VALIDATION',
        message: 'Only a scene in the manuscript can be continued'
      })
    }
    const before = await failure({ before: 'Too short.' })
    expect(before.code).toBe('VALIDATION')
    expect(before.message).toContain(`${WHAT_NEXT_TEXT_MIN} characters`)
    saveDocument(db, scene, doc('x'.repeat(WHAT_NEXT_TEXT_MIN - 1)))
    expect((await failure()).code).toBe('VALIDATION')
    expect(complete).not.toHaveBeenCalled()
  })

  it('sends the text up to the selection when the renderer sent it, and a blank one means the scene', async () => {
    const before = '  The ferry landing was empty when Mara reached it. The rope hung slack.  '
    await whatNext({ before })
    expect(sentText()).toBe(before.trim())
    answers(DIRECTIONS)
    await whatNext({ before: '   ' })
    expect(sentText(1)).toBe(SCENE)
  })

  it('sends the tail of a long scene, cut at a word boundary, and reports it as truncated', async () => {
    const long = `${SCENE} `.repeat(60).trim()
    saveDocument(db, scene, doc(long))
    const result = await whatNext()
    expect(result.truncated).toBe(true)
    const text = sentText()
    expect(text.length).toBeLessThanOrEqual(WHAT_NEXT_CHAR_BUDGET)
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('She set the lantern down on the post and waited.')).toBe(true)
    // The cut lands between words: what follows the ellipsis is a whole word of the scene.
    expect(long.endsWith(text.slice(1))).toBe(true)
    expect(long[long.length - text.length]).toMatch(/\s/)
  })

  it('carries the scene brief in the user turn and the story bible in the system turn', async () => {
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants the ledger back.' }
    })
    createTag(db, { name: 'Tomas', category: 'character' })
    await whatNext()
    expect(sent().user).toContain(
      'Scene brief (the author\'s intent):\n"""\nScene brief:\n- Goal: Mara wants the ledger back.'
    )
    expect(sent().system).toMatch(/tomas/i)
  })

  it("carries the scene's tone tags as the scene steer between the brief and the text, and misses the cache when they change (F-14.13)", async () => {
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants the ledger back.' }
    })
    await whatNext()
    expect(sent().user).not.toContain(SCENE_STEER_HEADING)
    addDocumentTag(db, scene, createTag(db, { name: 'tense', category: 'tone' }).id)
    answers(DIRECTIONS)
    await whatNext()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(sent(1).user).toContain(
      `Mara wants the ledger back.\n"""\n\n${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.\n\nText so far:`
    )
    expect(sent(1).system).not.toContain(SCENE_STEER_HEADING)
    expect(ledger[1]?.contextHash).not.toBe(ledger[0]?.contextHash)
  })

  it('answers the same request from the cache, and misses it when the text, the brief, or the bible change', async () => {
    await whatNext()
    await whatNext()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    answers(DIRECTIONS)
    await whatNext({ before: SCENE.slice(0, 80) })
    expect(complete).toHaveBeenCalledTimes(2)
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants the ledger back.' }
    })
    answers(DIRECTIONS)
    await whatNext()
    expect(complete).toHaveBeenCalledTimes(3)
    createTag(db, { name: 'Tomas', category: 'character' })
    answers(DIRECTIONS)
    await whatNext()
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('answers PROVIDER when the model does not reply in the expected shape', async () => {
    complete.mockReset()
    complete.mockResolvedValueOnce({
      text: 'Maybe a storm?',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 3 }
    })
    expect((await failure()).code).toBe('PROVIDER')
    complete.mockResolvedValueOnce({
      text: '{"ideas":[]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 600, outputTokens: 3 }
    })
    expect((await failure({ before: SCENE })).code).toBe('PROVIDER')
  })
})

describe('parseWhatNextAnswer (F-5.17)', () => {
  it('keeps at most three directions, trimmed and cut to the caps, and counts the rest', () => {
    const long = {
      title: ` ${'T'.repeat(WHAT_NEXT_TITLE_MAX + 20)} `,
      text: ` ${'x'.repeat(WHAT_NEXT_TEXT_MAX + 50)} `
    }
    const answer = JSON.stringify({
      directions: [
        long,
        { title: '  ', text: 'A blank title.' },
        { title: 'No text', text: '' },
        { title: 42, text: 'Wrong shape.' },
        DIRECTIONS[0],
        DIRECTIONS[1],
        DIRECTIONS[2]
      ]
    })
    const { directions, dropped } = parseWhatNextAnswer(answer)
    expect(directions).toHaveLength(WHAT_NEXT_DIRECTIONS)
    expect(directions[0]).toEqual({
      title: 'T'.repeat(WHAT_NEXT_TITLE_MAX),
      text: 'x'.repeat(WHAT_NEXT_TEXT_MAX)
    })
    expect(directions.slice(1)).toEqual([DIRECTIONS[0], DIRECTIONS[1]])
    expect(dropped).toBe(4)
  })

  it('answers no directions for an empty list, and PROVIDER for anything that is not the shape', () => {
    expect(parseWhatNextAnswer('{"directions":[]}')).toEqual({ directions: [], dropped: 0 })
    expect(() => parseWhatNextAnswer('not json')).toThrow(AiProviderError)
    expect(() => parseWhatNextAnswer('{"directions":"none"}')).toThrow(AiProviderError)
  })
})

describe('tailText (F-5.17)', () => {
  it('returns text that fits unchanged and cuts the rest from the front at a word boundary', () => {
    expect(tailText('short text', 20)).toBe('short text')
    expect(tailText('alpha beta gamma delta', 12)).toBe('…delta')
    expect(tailText('alpha beta gamma delta', 12).length).toBeLessThanOrEqual(12)
    // One word longer than the cap has no boundary to cut at: its tail stands.
    expect(tailText('x'.repeat(30), 10)).toBe(`…${'x'.repeat(9)}`)
  })
})
