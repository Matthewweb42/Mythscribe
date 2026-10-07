import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { CONTEXT_CHUNK_CHARS, type ContextProgress } from '@shared/contextLibrary'
import { aiProposal } from '../db/schema'
import { createEntity } from '../entity/entityStore'
import { addContextFiles, markContextFileProcessed, type LibraryDb } from '../library/libraryStore'
import { setAiSettings } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { contextWork, estimateContextImport, sortContextFiles } from './contextImport'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, registerInflight, resetInflight } from './inflight'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 7, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: LibraryDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]

function answer(json: unknown): void {
  complete.mockResolvedValue({
    text: JSON.stringify(json),
    model: 'gpt-5.4',
    usage: { inputTokens: 900, outputTokens: 120 }
  })
}

async function add(name: string, text: string): Promise<string> {
  const result = await addContextFiles(db, session.folder, [
    { name, read: () => Buffer.from(text, 'utf8') }
  ])
  const id = result.changed[0]
  if (id === undefined) throw new Error('nothing added')
  return id
}

const statuses = (): string[] =>
  db
    .select()
    .from(aiProposal)
    .all()
    .map((row) => row.status)

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-context-'))
  session = createProject(projectFolderFor(tmp, 'Ctx'), 'Ctx', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  answer({ entities: [], notes: [], images: [] })
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

describe('contextWork (F-9.8)', () => {
  it('cuts long text at paragraph boundaries, lists images, and skips a file with no text', async () => {
    const long = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(CONTEXT_CHUNK_CHARS / 4)).join('\n\n')
    const a = await add('long.txt', long)
    const image = (
      await addContextFiles(db, session.folder, [{ name: 'map.png', read: () => Buffer.from([1]) }])
    ).changed[0]!
    const work = await contextWork(db, session.folder, [a, image])
    expect(work.files).toBe(1)
    expect(work.chunks.map((c) => [c.part, c.parts])).toEqual([
      [1, 2],
      [2, 2]
    ])
    expect(work.chunks.every((c) => c.text.length <= CONTEXT_CHUNK_CHARS)).toBe(true)
    expect(work.images).toEqual([{ id: image, name: 'map.png' }])
  })

  it('sends only the paragraphs an updated file did not have when it was last sorted', async () => {
    const id = await add('notes.md', 'Mara is 34.\n\nTomas is her brother.')
    markContextFileProcessed(db, id, 'Mara is 34.\n\nTomas is her brother.', NOW.toISOString())
    // Sorted as it stands: a reprocess reads it whole again.
    expect((await contextWork(db, session.folder, [id])).chunks.map((c) => c.changedOnly)).toEqual([
      false
    ])
    await add('notes.md', 'Mara is 34.\n\nTomas is her brother.\n\nIlse keeps the bell.')
    const work = await contextWork(db, session.folder, [id])
    expect(work.chunks).toEqual([
      {
        fileId: id,
        fileName: 'notes.md',
        part: 1,
        parts: 1,
        changedOnly: true,
        text: 'Ilse keeps the bell.'
      }
    ])
  })

  it('estimates on the strong model', async () => {
    const id = await add('notes.md', 'x'.repeat(4_000))
    const estimate = await estimateContextImport(db, session.folder, [id], 'gpt-5.4')
    expect(estimate).toMatchObject({ files: 1, chunks: 1, model: 'gpt-5.4', priced: true })
    expect(estimate.costUsd).toBeGreaterThan(0)
  })
})

describe('sortContextFiles (F-9.8)', () => {
  it('sends each chunk on the strong tier in JSON mode and answers the review', async () => {
    createEntity(db, { kind: 'character', name: 'Mara Vell', fields: { age: '34' } })
    const id = await add('people.md', 'Mara, 35, ferrywoman.\n\nTomas, her brother.')
    answer({
      entities: [
        { kind: 'character', name: 'Mara Vell', aliases: ['Mara'], fields: { age: 35 }, details: [] },
        { kind: 'character', name: 'Tomas', fields: { relationships: 'Brother of Mara' } },
        { kind: 'spaceship', name: 'Nope' },
        { kind: 'world', name: 'Project notes', details: ['x'] }
      ],
      notes: ['Theme: debts.'],
      images: [{ file: 'not-uploaded.png', name: 'Mara Vell' }]
    })
    const progress: ContextProgress[] = []
    const review = await sortContextFiles(db, deps, {
      folder: session.folder,
      fileIds: [id],
      requestId: 'r-1',
      onProgress: (p) => progress.push(p)
    })

    const request = complete.mock.calls[0]![0]
    expect(request.tier).toBe('strong')
    expect(request.json).toBe(true)
    expect(request.maxTokens).toBe(3_000)
    expect(request.messages[1]?.content).toContain('Characters: Mara Vell')
    expect(request.messages[1]?.content).toContain('Document "people.md":\nMara, 35')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ feature: 'contextImport', promptVersion: 'contextImport.v1' })
    expect(progress).toEqual([{ done: 1, total: 1, costUsd: priceFor('gpt-5.4', 900, 120).costUsd }])
    expect(review).toMatchObject({
      fileIds: [id],
      chunks: 1,
      model: 'gpt-5.4',
      promptVersion: 'contextImport.v1',
      notes: { existingId: null, paragraphs: ['Theme: debts.'], include: true }
    })
    expect(review.proposalIds).toHaveLength(1)
    expect(statuses()).toEqual(['pending'])
    expect(review.entities.map((e) => [e.name, e.existingId === null])).toEqual([
      ['Mara Vell', false],
      ['Tomas', true]
    ])
    expect(review.entities[0]?.fields).toEqual([
      { field: 'age', upload: '35', existing: '34', include: true, choice: 'existing' }
    ])
  })

  it('is refused with DISABLED while Use AI is off, before anything is sent', async () => {
    setAiSettings(db, defaultAiSettings())
    const id = await add('a.md', 'Text.')
    await expect(
      sortContextFiles(db, deps, { folder: session.folder, fileIds: [id], requestId: 'r-1' })
    ).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers PROVIDER for a malformed answer and settles the chunk rejected', async () => {
    const id = await add('a.md', 'Text.')
    complete.mockResolvedValue({
      text: '{"entities": "no"}',
      model: 'gpt-5.4',
      usage: { inputTokens: 10, outputTokens: 2 }
    })
    await expect(
      sortContextFiles(db, deps, { folder: session.folder, fileIds: [id], requestId: 'r-1' })
    ).rejects.toBeInstanceOf(AiProviderError)
    expect(statuses()).toEqual(['rejected'])
  })

  it('stops on a cancel between chunks and settles what was answered', async () => {
    const long = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(CONTEXT_CHUNK_CHARS / 4)).join('\n\n')
    const id = await add('long.txt', long)
    const controller = registerInflight('r-1')
    complete.mockImplementation(() => {
      cancelInflight('r-1')
      return Promise.resolve({
        text: '{"entities":[]}',
        model: 'gpt-5.4',
        usage: { inputTokens: 10, outputTokens: 2 }
      })
    })
    await expect(
      sortContextFiles(db, deps, {
        folder: session.folder,
        fileIds: [id],
        requestId: 'r-1',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
