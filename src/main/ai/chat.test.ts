import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inputBudget, outputBudget, priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { CHAT_MESSAGE_MAX, CHAT_TOKENS_PER_PARAGRAPH } from '@shared/chat'
import { builtinParams, defaultWritingPresets } from '@shared/presets'
import { computeStylometrics } from '@shared/stylometry'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { setAiSettings, setAuthorRules, setWritingPresets } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { checkChatFidelity, postProcessChatText, runChat, type ChatInput } from './chat'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import type { ChatTurn } from './prompts/chat.v2'
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
import type { UsageEntry } from './usageStore'

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
let provider: Provider | null
let scene: string
let dailyCapUsd: number

const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** One paragraph of third-person past narration with four dialogue tags; six of them trip the tense, person, and tag rules. */
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

function answers(...texts: string[]): void {
  for (const text of texts) {
    complete.mockResolvedValueOnce({
      text,
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
  }
}

const input = (over: Partial<ChatInput> = {}): ChatInput => ({
  nodeId: scene,
  mode: 'plan',
  paragraphs: 1,
  message: 'What is Mara afraid of?',
  history: [],
  ...over
})

const ask = (
  over: Partial<ChatInput> = {},
  onDelta: (delta: string) => void = () => {}
): ReturnType<typeof runChat> => runChat(db, deps, input(over), onDelta)

async function failure(over: Partial<ChatInput> = {}): Promise<{ code: string; message: string }> {
  try {
    await ask(over)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-chat-'))
  session = createProject(projectFolderFor(tmp, 'Chat'), 'Chat', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(SCENE))
  setAiSettings(db, { ...defaultAiSettings(), dial: 2 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue({
    text: 'Somewhere ahead the river was rising.',
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 120, outputTokens: 12 }
  })
  chunks = [
    { delta: 'The storm, ' },
    { delta: 'per the opening.', usage: { inputTokens: 90, outputTokens: 8 } }
  ]
  stream = vi.fn<Stream>(async function* () {
    for (const chunk of chunks) {
      if (chunk instanceof Error) throw chunk
      yield chunk
    }
  })
  ledger = []
  dailyCapUsd = defaultAiUsageState().dailyCapUsd
  provider = {
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

describe('runChat, Plan mode (F-5.4)', () => {
  it('streams the answer through onDelta, resolves the whole text, and logs one fast-tier chat.v2 row with no temperature', async () => {
    const seen: string[] = []
    const result = await ask({}, (delta) => void seen.push(delta))
    expect(seen).toEqual(['The storm, ', 'per the opening.'])
    expect(result).toEqual({
      text: 'The storm, per the opening.',
      usage: { inputTokens: 90, outputTokens: 8 },
      costUsd: priceFor('gpt-5.4-mini', 90, 8).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'chat.v2',
      flagged: false,
      violation: null
    })
    expect(complete).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledTimes(1)
    const request = stream.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', maxTokens: outputBudget('chat') })
    expect('temperature' in request).toBe(false)
    expect(request.json).toBeUndefined()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'chat',
      tier: 'fast',
      promptVersion: 'chat.v2',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sends the scene text system-side, the history as turns, and the message last; never the voice block or the metadata', async () => {
    setSceneMeta(db, scene, { location: 'Ridge', pov: 'Mara', timeline: '' })
    saveDocument(db, scene, doc(Array(6).fill(VOICE_PARAGRAPH).join(' ')))
    const history: ChatTurn[] = [
      { role: 'user', content: 'Who is on the ridge?' },
      { role: 'assistant', content: 'Mara.' }
    ]
    await ask({ history })
    const messages = stream.mock.calls[0]![0].messages
    expect(messages).toHaveLength(4)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain(`Active scene:\n"""\n${VOICE_PARAGRAPH}`)
    expect(messages[0]?.content).not.toContain("Match the author's voice")
    expect(messages[0]?.content).not.toContain('Scene: location')
    expect(messages.slice(1, 3)).toEqual(history)
    expect(messages[3]).toEqual({ role: 'user', content: 'What is Mara afraid of?' })
  })

  it('says no scene is open for a null nodeId and reads nothing', async () => {
    await ask({ nodeId: null })
    expect(stream.mock.calls[0]![0].messages[0]?.content).toContain('No scene is open')
    expect(stream.mock.calls[0]![0].messages[0]?.content).not.toContain('Active scene')
  })

  it('pulls the notes behind a #name that names a bank tag and ignores an unknown name', async () => {
    const mara = createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    addDocumentTag(db, scene, mara.id)
    saveNotes(db, scene, doc('Mara fears the river.'))
    await ask({ message: 'Tell me about #Mara and #nobody.' })
    const system = stream.mock.calls[0]![0].messages[0]?.content ?? ''
    expect(system).toContain('Referenced notes:\n#mara:\nMara fears the river.')
    expect(system).not.toContain('#nobody')
    expect(system.indexOf('Referenced notes')).toBeLessThan(system.indexOf('Active scene'))
  })

  it('answers the same turn from the cache and misses it when the scene, the message, or the history change', async () => {
    await ask()
    await ask()
    expect(stream).toHaveBeenCalledTimes(1)
    expect(ledger[1]?.cached).toBe(true)
    await ask({ message: 'Different.' })
    expect(stream).toHaveBeenCalledTimes(2)
    await ask({ history: [{ role: 'user', content: 'Earlier.' }] })
    expect(stream).toHaveBeenCalledTimes(3)
    saveDocument(db, scene, doc('A new opening.'))
    await ask()
    expect(stream).toHaveBeenCalledTimes(4)
  })

  it('drops the oldest history turns until the prompt fits the chat input budget', async () => {
    const long = 'h'.repeat(CHAT_MESSAGE_MAX)
    const history: ChatTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}${long}`
    }))
    await ask({ history })
    const messages = stream.mock.calls[0]![0].messages
    const kept = messages.slice(1, -1)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(10)
    // The newest turns survive.
    expect(kept.at(-1)?.content.startsWith('9')).toBe(true)
    const estimate = Math.ceil(messages.map((m) => m.content).join('\n').length / 4)
    expect(estimate).toBeLessThanOrEqual(inputBudget('chat'))
  })

  it('refuses with DISABLED when chat is below Ask or toggled off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Assistant chat needs the AI dial at Ask or higher (it is at Off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 2, features: { ...on.features, chat: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Assistant chat is turned off for this project.'
    })
    expect(stream).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('lets a budget refusal (the daily cap) and a provider error propagate, logging nothing', async () => {
    dailyCapUsd = 0
    expect((await failure()).code).toBe('BUDGET')
    dailyCapUsd = 2
    chunks = [new AiRateLimitError('Slow down.')]
    expect((await failure()).code).toBe('RATE_LIMIT')
    expect(ledger).toHaveLength(0)
  })

  it('refuses an unknown node with NOT_FOUND', async () => {
    expect((await failure({ nodeId: 'nope' })).code).toBe('NOT_FOUND')
  })

  it('hands the requestId to the stream as its signal, and a cancel mid-stream rejects with CANCELLED after the deltas shown (F-5.10)', async () => {
    stream.mockImplementationOnce(async function* (request) {
      yield { delta: 'Half' }
      await untilCancelled(request)
    })
    const seen: string[] = []
    const pending = ask({ requestId: 'c-1' }, (delta) => void seen.push(delta))
    await vi.waitFor(() => expect(seen).toEqual(['Half']))
    expect(stream.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('c-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(0)
    expect(inflightCount()).toBe(0)
    await ask()
    expect('signal' in stream.mock.calls[1]![0]).toBe(false)
  })
})

describe('runChat, Agent mode (F-5.4, F-14.7)', () => {
  const agent = (over: Partial<ChatInput> = {}): Partial<ChatInput> => ({
    mode: 'agent',
    paragraphs: 3,
    message: 'Bring Tomas onto the landing.',
    ...over
  })
  /** A manuscript strong enough for the tense and person rules. */
  const strongProfile = (): void => {
    saveDocument(db, scene, doc(Array(6).fill(VOICE_PARAGRAPH).join(' ')))
  }

  it('completes as a whole (no deltas) with the preset temperature, the per-paragraph cap, the metadata, and the voice block', async () => {
    strongProfile()
    setSceneMeta(db, scene, { location: 'Ferry landing', pov: 'Mara', timeline: '' })
    setWritingPresets(db, { ...defaultWritingPresets(), active: 'suspense' })
    answers(CLEAN)
    const seen: string[] = []
    const result = await ask(agent(), (delta) => void seen.push(delta))
    expect(seen).toEqual([])
    expect(stream).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(1)
    const suspense = builtinParams('suspense')
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({
      tier: 'fast',
      maxTokens: 3 * CHAT_TOKENS_PER_PARAGRAPH,
      temperature: suspense.temperature
    })
    const system = request.messages[0]?.content ?? ''
    expect(system).toContain("Match the author's voice:")
    expect(system).toContain(suspense.styleInstruction)
    expect(system).toContain('Scene: location Ferry landing, POV Mara, timeline —.')
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(
      system.indexOf(suspense.styleInstruction)
    )
    expect(request.messages.at(-1)?.content).toBe(
      'Write 3 paragraphs. Bring Tomas onto the landing.'
    )
    expect(result).toEqual({
      text: CLEAN,
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'chat.v2',
      flagged: false,
      violation: null
    })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['chat.v2'])
  })

  it('post-processes the draft: trims and strips wrapping quotes, keeping paragraph breaks', async () => {
    answers('  "First paragraph.\n\nSecond paragraph."  ')
    expect((await ask(agent())).text).toBe('First paragraph.\n\nSecond paragraph.')
    expect(postProcessChatText('“Rain.”')).toBe('Rain.')
    expect(postProcessChatText('"Run," she said. "Now."')).toBe('"Run," she said. "Now."')
    expect(postProcessChatText('  ')).toBe('')
  })

  it('regenerates an off-voice draft once through chatRegen.v2 with the violation named, and shows the clean second draft with both calls summed', async () => {
    strongProfile()
    answers(OFF_VOICE, CLEAN)
    const result = await ask(agent())
    expect(complete).toHaveBeenCalledTimes(2)
    const second = complete.mock.calls[1]![0]
    expect(second.messages[0]?.content).toContain(
      "Your last attempt switches to present tense. Write a different draft that keeps the manuscript's voice."
    )
    expect(second.messages.slice(1)).toEqual(complete.mock.calls[0]![0].messages.slice(1))
    expect(ledger.map((row) => row.promptVersion)).toEqual(['chat.v2', 'chatRegen.v2'])
    expect(ledger[0]!.contextHash).not.toBe(ledger[1]!.contextHash)
    expect(result).toEqual({
      text: CLEAN,
      usage: { inputTokens: 240, outputTokens: 24 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd * 2,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'chatRegen.v2',
      flagged: false,
      violation: null
    })
  })

  it('shows the second draft flagged when it is off-voice too, and falls back to the first, flagged, when the regenerate fails or comes back empty', async () => {
    strongProfile()
    answers(OFF_VOICE, OFF_VOICE)
    expect(await ask(agent())).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      violation: 'switches to present tense',
      promptVersion: 'chatRegen.v2'
    })
    answers(OFF_VOICE)
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    expect(await ask(agent({ message: 'Again.' }))).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      violation: 'switches to present tense',
      promptVersion: 'chat.v2',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
    answers(OFF_VOICE, '""')
    expect(await ask(agent({ message: 'Once more.' }))).toMatchObject({
      text: OFF_VOICE,
      flagged: true,
      promptVersion: 'chat.v2',
      usage: { inputTokens: 240, outputTokens: 24 }
    })
  })

  it('regenerates an Agent draft that uses a banned phrase, naming it (F-14.2)', async () => {
    const banned = 'They walked back to the ferry and did not delve into it again.'
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    answers(banned, CLEAN)
    const result = await ask(agent())
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]![0].messages[0]?.content).toContain(
      'Never use these phrases: delve.'
    )
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain(
      'Your last attempt uses the phrase \u201Cdelve\u201D, which the author has banned.'
    )
    expect(result).toMatchObject({ text: CLEAN, flagged: false, violation: null })
  })

  it('never regenerates on a stylometric signal for a project with no rules and no exemplars, and misses the cache when the voice version moves', async () => {
    saveDocument(db, scene, doc(SCENE))
    answers(OFF_VOICE)
    const result = await ask(agent())
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ text: OFF_VOICE, flagged: false, violation: null })
    await ask(agent())
    expect(complete).toHaveBeenCalledTimes(1)
    bumpVoiceVersion()
    answers(OFF_VOICE)
    await ask(agent())
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('registers the regenerate under id:regen, and a cancel during it propagates as CANCELLED instead of falling back (F-5.10)', async () => {
    strongProfile()
    answers(OFF_VOICE)
    complete.mockImplementationOnce(untilCancelled)
    const pending = ask(agent({ requestId: 'c-1' }))
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('c-1')).toBe(false) // the first call is released
    expect(cancelInflight('c-1:regen')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(1)
    expect(inflightCount()).toBe(0)
  })

  it('refuses with DISABLED below Suggest even though chat itself is allowed at Ask', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
    expect(await failure(agent())).toEqual({
      code: 'DISABLED',
      message: 'Agent mode needs the AI dial at Suggest or higher (it is at Ask).'
    })
    expect(complete).not.toHaveBeenCalled()
    // The ghost-text toggle does not gate Agent mode: only the level does.
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 2, features: { ...on.features, ghostText: false } })
    answers(CLEAN)
    expect((await ask(agent())).text).toBe(CLEAN)
  })
})

describe('checkChatFidelity', () => {
  it('scores a short draft as a fragment and a long one as a document', () => {
    const profile = computeStylometrics(Array(6).fill(VOICE_PARAGRAPH).join(' '))
    expect(checkChatFidelity(profile, OFF_VOICE)[0]?.message).toBe('switches to present tense')
    const longOffVoice = Array(30).fill(OFF_VOICE).join(' ')
    expect(checkChatFidelity(profile, longOffVoice)[0]?.message).toBe(
      'Narrated in present tense; the manuscript is in past tense.'
    )
    expect(checkChatFidelity(profile, CLEAN)).toEqual([])
  })

  it('checks the banned phrases at either length and puts them first (F-14.2)', () => {
    const profile = computeStylometrics(Array(6).fill(VOICE_PARAGRAPH).join(' '))
    const message = 'uses the phrase \u201Cdelve\u201D, which the author has banned'
    expect(checkChatFidelity(profile, `${CLEAN} She would not delve further.`, ['delve'])).toEqual([
      { code: 'bannedPhrase', message }
    ])
    const long = `${Array(30).fill(OFF_VOICE).join(' ')} I will not delve into it.`
    expect(checkChatFidelity(profile, long, ['delve'])[0]).toEqual({
      code: 'bannedPhrase',
      message
    })
    expect(checkChatFidelity(profile, CLEAN, ['delve'])).toEqual([])
  })
})
