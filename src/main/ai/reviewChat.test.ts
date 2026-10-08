import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { ContextReview } from '@shared/contextLibrary'
import { REVIEW_CHAT_MAX_OPS } from '@shared/reviewChat'
import { aiProposal } from '../db/schema'
import type { LibraryDb } from '../library/libraryStore'
import { setAiSettings } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import { REVIEW_CHAT_RETRY_TURN } from './prompts/reviewChat.v1'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import { parseReviewChatAnswer, runReviewChat } from './reviewChat'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 8, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: LibraryDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]

const review: ContextReview = {
  fileIds: ['f1'],
  entities: [
    {
      id: 'e1',
      kind: 'character',
      name: 'Rynna',
      existingId: null,
      include: true,
      tag: true,
      records: [
        {
          id: 'r1',
          fileId: 'f1',
          fileName: 'lore.md',
          kind: 'character',
          name: 'Rynna',
          aliases: [],
          fields: {},
          details: []
        }
      ],
      fields: [],
      details: [],
      includeDetails: true,
      images: []
    }
  ],
  notes: { existingId: null, paragraphs: [], include: true },
  proposalIds: [],
  chunks: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  model: 'gpt-5.4',
  promptVersion: 'contextImport.v1'
}

const reply = (text: string, finishReason = 'stop'): CompletionResult => ({
  text,
  model: 'gpt-5.4',
  usage: { inputTokens: 700, outputTokens: 60 },
  finishReason
})

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-reviewchat-'))
  session = createProject(projectFolderFor(tmp, 'Chat'), 'Chat', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: { get: () => undefined, put: () => {} },
    dailyCap: { get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }), spend: () => {} },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const run = (): ReturnType<typeof runReviewChat> =>
  runReviewChat(db, deps, {
    review,
    history: [],
    message: 'Rynna is a place.',
    requestId: 'rc-1'
  })

describe('parseReviewChatAnswer (F-9.9)', () => {
  it('keeps the operations that parse, counts the rest, and reads a fenced answer', () => {
    const parsed = parseReviewChatAnswer(
      '```json\n' +
        JSON.stringify({
          reply: ' Done. ',
          ops: [
            { op: 'kind', item: 'e1', kind: ' Setting ' },
            { op: 'merge', items: ['e1'] },
            { op: 'explode', item: 'e1' }
          ]
        }) +
        '\n```'
    )
    expect(parsed).toEqual({
      ops: [{ op: 'kind', item: 'e1', kind: 'setting' }],
      reply: 'Done.',
      dropped: 2
    })
  })

  it('caps the operations and reads a missing list as none', () => {
    const many = Array.from({ length: REVIEW_CHAT_MAX_OPS + 3 }, () => ({
      op: 'include',
      item: 'e1',
      include: false
    }))
    expect(parseReviewChatAnswer(JSON.stringify({ ops: many }))?.dropped).toBe(3)
    expect(parseReviewChatAnswer('{"reply":"No."}')).toEqual({ ops: [], reply: 'No.', dropped: 0 })
    expect(parseReviewChatAnswer('not json')).toBeNull()
    expect(parseReviewChatAnswer('[1,2]')).toBeNull()
  })
})

describe('runReviewChat (F-9.9)', () => {
  it('sends the review and the message on the strong tier and answers the operations as a proposal', async () => {
    complete.mockResolvedValue(
      reply(
        JSON.stringify({
          reply: 'Rynna is now a setting.',
          ops: [{ op: 'kind', item: 'e1', kind: 'setting' }]
        })
      )
    )
    const answer = await run()
    expect(answer.ops).toEqual([{ op: 'kind', item: 'e1', kind: 'setting' }])
    expect(answer.reply).toBe('Rynna is now a setting.')
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.json).toBe(true)
    expect(request.messages[1]?.content).toContain('e1 · character · Rynna · new sheet')
    expect(request.messages.at(-1)?.content).toBe('Rynna is a place.')
    expect(ledger.map((row) => [row.feature, row.tier, row.promptVersion])).toEqual([
      ['reviewChat', 'strong', 'reviewChat.v1']
    ])
    const proposals = db.select().from(aiProposal).all()
    expect(proposals.map((p) => [p.id, p.feature, p.status])).toEqual([
      [answer.proposalId, 'reviewChat', 'pending']
    ])
  })

  it('asks once more, briefly and with room, when the answer was cut off, adding both requests up', async () => {
    complete
      .mockResolvedValueOnce(reply('{"reply":"Rynna is', 'length'))
      .mockResolvedValueOnce(reply('{"reply":"Done.","ops":[]}'))
    const answer = await run()
    expect(answer.reply).toBe('Done.')
    expect(complete).toHaveBeenCalledTimes(2)
    const retry = complete.mock.calls[1]![0]
    expect(retry.messages.at(-1)?.content).toBe(REVIEW_CHAT_RETRY_TURN)
    expect(retry.maxTokens).toBeGreaterThan(complete.mock.calls[0]![0].maxTokens)
    expect(answer.usage).toEqual({ inputTokens: 1_400, outputTokens: 120 })
    expect(ledger).toHaveLength(2)
  })

  it('fails as PROVIDER when the retry is unreadable too, with no proposal', async () => {
    complete.mockResolvedValue(reply('I would merge them.'))
    await expect(run()).rejects.toMatchObject({ code: 'PROVIDER' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(db.select().from(aiProposal).all()).toEqual([])
  })

  it('is refused while the review chat is switched off, before anything is sent', async () => {
    const settings = defaultAiSettings()
    setAiSettings(db, {
      ...settings,
      dial: 1,
      features: { ...settings.features, reviewChat: false }
    })
    await expect(run()).rejects.toBeInstanceOf(AiProviderError)
    await expect(run()).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })
})
