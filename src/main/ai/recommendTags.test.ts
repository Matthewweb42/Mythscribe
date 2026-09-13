import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { setAiSettings } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag, type TagDb } from '../tag/tagStore'
import { listNodes } from '../tree/treeStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import { recommendTags } from './recommendTags'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 8, 13, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TagDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let provider: Provider | null
let scene: string
let folder: string

/** `complete` answers with this text; tests replace it per case. */
function answer(text: string): void {
  complete.mockResolvedValue({
    text,
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 40, outputTokens: 10 }
  })
}

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})
const LONG = 'The storm broke at dusk over the dark forest, and Mara counted the lightning gaps.'

async function failure(nodeId = scene): Promise<{ code: string; message: string }> {
  try {
    await recommendTags(db, deps, nodeId)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-recommend-'))
  session = createProject(projectFolderFor(tmp, 'Rec'), 'Rec', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)?.id ?? ''
  if (!scene || !folder) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(LONG))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answer('{"tags":["dark-forest","protagonist"]}')
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
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('recommendTags (F-4.7)', () => {
  it('sends the text and the bank names as tags.v1 in JSON mode on the fast tier and maps names back to bank tags', async () => {
    const forest = createTag(db, { name: 'Dark Forest', category: 'setting' })
    const hero = createTag(db, { name: 'Protagonist', category: 'character' })
    const result = await recommendTags(db, deps, scene)
    expect(result).toEqual({
      suggestions: [forest, hero],
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: priceFor('gpt-5.4-mini', 40, 10).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'tags.v1'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.tier).toBe('fast')
    expect(request.json).toBe(true)
    expect(request.maxTokens).toBe(200)
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.content).toBe(
      `Tag bank: dark-forest, protagonist\n\nPassage:\n${LONG}`
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ feature: 'tags', promptVersion: 'tags.v1', cached: false })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('drops an already-linked tag, a name outside the bank, and a repeat; tolerates un-kebabed names', async () => {
    const forest = createTag(db, { name: 'Dark Forest', category: 'setting' })
    const hero = createTag(db, { name: 'Protagonist', category: 'character' })
    addDocumentTag(db, scene, forest.id)
    answer('{"tags":["dark-forest","Protagonist","ghost-ship","protagonist","PROTAGONIST"]}')
    const { suggestions } = await recommendTags(db, deps, scene)
    expect(suggestions).toEqual([hero])
  })

  it('caps the suggestions at 8 whatever the model returns', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `tag-${i}`)
    for (const name of names) createTag(db, { name, category: 'custom' })
    answer(JSON.stringify({ tags: [...names].reverse() }))
    const { suggestions } = await recommendTags(db, deps, scene)
    expect(suggestions.map((t) => t.name)).toEqual(names.slice(4).reverse())
  })

  it('answers from the cache on an identical request and says so', async () => {
    createTag(db, { name: 'Dark Forest', category: 'setting' })
    await recommendTags(db, deps, scene)
    const again = await recommendTags(db, deps, scene)
    expect(again).toMatchObject({
      cached: true,
      costUsd: 0,
      suggestions: [{ name: 'dark-forest' }]
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('maps an answer that is not JSON, or not { tags: string[] }, to PROVIDER with a message naming the problem', async () => {
    createTag(db, { name: 'Dark Forest', category: 'setting' })
    const expected = {
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.'
    }
    answer('Sure! Here are the tags: dark-forest')
    expect(await failure()).toEqual(expected)
    answer('{"labels":["dark-forest"]}')
    // A new answer text, so the cache does not serve the first bad answer.
    saveDocument(db, scene, doc(`${LONG} And then it rained.`))
    expect(await failure()).toEqual(expected)
    answer('{"tags":[1,2]}')
    saveDocument(db, scene, doc(`${LONG} And then it snowed.`))
    expect(await failure()).toEqual(expected)
    answer('["dark-forest"]')
    saveDocument(db, scene, doc(`${LONG} And then it cleared.`))
    expect(await failure()).toEqual(expected)
  })

  it('refuses with DISABLED below the dial or with the tags toggle off, before touching the provider', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Tag suggestions needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { dial: 1, features: { ...on.features, tags: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Tag suggestions is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toEqual([])
  })

  it('passes the request path failures through (NO_KEY here)', async () => {
    provider = null
    expect(await failure()).toEqual({ code: 'NO_KEY', message: 'No API key is saved.' })
  })

  it('refuses a document under 50 characters with VALIDATION, before the dial', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    saveDocument(db, scene, doc('Too short.'))
    expect(await failure()).toMatchObject({ code: 'VALIDATION' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('counts an inline tag token as its #name for the gate and sends it that way', async () => {
    const forest = createTag(db, { name: 'dark-forest', category: 'setting' })
    saveDocument(db, scene, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Rain fell on the ' },
            { type: 'inlineTag', attrs: { id: forest.id, name: 'dark-forest' } },
            { type: 'text', text: ' until nobody could see.' }
          ]
        }
      ]
    })
    answer('{"tags":["dark-forest"]}')
    await recommendTags(db, deps, scene)
    expect(complete.mock.calls[0]![0].messages[1]?.content).toContain(
      'Rain fell on the #dark-forest until nobody could see.'
    )
  })

  it('refuses a folder with VALIDATION and an unknown id with NOT_FOUND', async () => {
    expect(await failure(folder)).toEqual({
      code: 'VALIDATION',
      message: 'Only documents have content'
    })
    expect(await failure('nope')).toMatchObject({ code: 'NOT_FOUND' })
  })
})
