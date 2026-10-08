import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { draftForAgent, draftMessage, draftParagraphs, type AgentDraftInput } from './agentDraft'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import {
  AiCutOffError,
  AiFallbackError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'

const NOW = new Date(2026, 9, 7, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let scene: string

const BEFORE = 'The ledger sat on the mill desk. Stunned silence.'
const DRAFT = 'Tomas looked at the elm and said nothing.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const said = (text: string, finishReason?: string): CompletionResult => ({
  text,
  model: 'gpt-5.4-mini',
  usage: { inputTokens: 300, outputTokens: 20 },
  ...(finishReason === undefined ? {} : { finishReason })
})

const draft = (
  over: Partial<AgentDraftInput> = {},
  onDelta: (delta: string) => void = () => undefined
): ReturnType<typeof draftForAgent> =>
  draftForAgent(
    db,
    deps,
    {
      nodeId: scene,
      brief: 'Tomas looks at the elm.',
      words: 120,
      before: BEFORE,
      after: '',
      passage: null,
      ...over
    },
    onDelta
  )

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-agent-draft-'))
  session = createSeededProject(projectFolderFor(tmp, 'Draft'), 'Draft', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(`${BEFORE} The rain came after.`))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>(() => Promise.resolve(said(DRAFT, 'stop')))
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* (req) {
      const reply = await complete(req)
      const cut = Math.floor(reply.text.length / 2)
      yield { delta: reply.text.slice(0, cut) }
      yield {
        delta: reply.text.slice(cut),
        usage: reply.usage,
        ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason })
      }
    },
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  deps = {
    providers: { get: () => provider },
    ledger: { insert: () => undefined },
    cache: { get: () => undefined, put: () => undefined },
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

describe('draftForAgent (2026-10-07)', () => {
  it('drafts an insertion through the assistant drafting prompt, continuing the text before the anchor, and streams it', async () => {
    const deltas: string[] = []
    const result = await draft({}, (delta) => deltas.push(delta))
    expect(result.text).toBe(DRAFT)
    expect(deltas.join('')).toBe(DRAFT)
    const sent = complete.mock.calls[0]![0]
    expect(sent.tier).toBe('fast')
    expect(sent.feature).toBe('chat')
    expect(sent.messages[0]?.content).toContain(`Active scene:\n"""\n${BEFORE}\n"""`)
    expect(sent.messages[0]?.content).not.toContain('The rain came after.')
    expect(sent.messages.at(-1)?.content).toBe(
      `Write 2 paragraphs. ${draftMessage('Tomas looks at the elm.', 120)}`
    )
    expect(result.promptVersion).toBe('chat.v5')
  })

  it('drafts a rewrite of a passage through the rewrite prompt with the brief as the note', async () => {
    const result = await draft({
      passage: 'The rain came after.',
      before: BEFORE,
      after: '',
      brief: 'Make the rain arrive with a sound.'
    })
    expect(result.text).toBe(DRAFT)
    const sent = complete.mock.calls[0]![0]
    expect(sent.feature).toBe('rewrite')
    expect(JSON.stringify(sent.messages)).toContain('Make the rain arrive with a sound.')
  })

  it('fails instead of offering nothing: cut off before any text, or empty', async () => {
    complete.mockResolvedValueOnce(said('', 'length'))
    await expect(draft()).rejects.toBeInstanceOf(AiCutOffError)
    complete.mockResolvedValueOnce(said('  ', 'stop'))
    await expect(draft()).rejects.toBeInstanceOf(AiFallbackError)
  })

  it('turns a length ask into paragraphs and a message, clamped', () => {
    expect(draftParagraphs(0)).toBe(2)
    expect(draftParagraphs(60)).toBe(1)
    expect(draftParagraphs(5000)).toBe(10)
    expect(draftMessage(' Beat. ', 10)).toBe('Beat. (about 20 words)')
  })
})
