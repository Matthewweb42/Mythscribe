import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, inputBudget, priceFor } from '@shared/ai'
import { AGENT_CUT_OFF_MESSAGE, AGENT_MAX_STEPS, type AgentStep } from '@shared/agent'
import { defaultAiSettings } from '@shared/aiSettings'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createEntity } from '../entity/entityStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setAiSettings, setAuthorRules } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { createTag } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { manuscriptDocuments } from '../voice/profile'
import {
  AGENT_DROPPED_RESULT,
  AGENT_OUT_OF_STEPS,
  AnswerStream,
  agentStepRequestId,
  fitAgentPrompt,
  parseAgentReply,
  readAgentReply,
  readOrganiseRequest,
  runAgent,
  type AgentInput
} from './agent'
import {
  NOTES_ARE_PLANS,
  SHEETS_ARE_PLANS,
  loadAgentProject,
  occurrencesOf,
  resolveAgentEdit,
  runAgentTool
} from './agentTools'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import { AGENT_FINAL_TURN, AGENT_RULES } from './prompts/agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './prompts/agent.v2'
import { AGENT_TIME_RULES } from './prompts/agent.v3'
import { AGENT_ORGANISE_RULES } from './prompts/agent.v4'
import { STORY_MAP_HEADING } from '@shared/storyTime'
import {
  AiCancelledError,
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 6, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scenes: string[]
let steps: AgentStep[]

const LEDGER =
  'The ledger sat on the mill desk where Tomas had left it. Mara copied the ledger twice and ' +
  'hid the copy under the elm in the north pasture.'
const QUIET = 'Mara stood in the yard and the lantern would not stay lit.'
const QUOTE = 'Mara copied the ledger twice'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const said = (value: unknown): CompletionResult => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  model: 'gpt-5.4',
  usage: { inputTokens: 500, outputTokens: 40 }
})

/** The model's next replies, in order. */
function replies(...values: unknown[]): void {
  for (const value of values) complete.mockResolvedValueOnce(said(value))
}

const run = (over: Partial<AgentInput> = {}): ReturnType<typeof runAgent> =>
  runAgent(
    db,
    deps,
    {
      nodeId: scenes[0] ?? null,
      message: 'Where did Mara hide the ledger?',
      history: [],
      access: 'read',
      focus: { beforeCaret: '', selection: '' },
      ...over
    },
    (step) => steps.push(step)
  )

/** The ref the run gives `nodeId` (tree order is stable within a test). */
const ref = (nodeId: string | undefined): string =>
  loadAgentProject(db).refOf.get(nodeId ?? '') ?? ''

const request = (call: number): CompletionRequest => {
  const value = complete.mock.calls[call]?.[0]
  if (!value) throw new Error(`no request ${call}`)
  return value
}

beforeEach(() => {
  resetInflight()
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-agent-'))
  session = createSeededProject(projectFolderFor(tmp, 'Agent'), 'Agent', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  if (scenes.length < 3) throw new Error('skeleton not seeded')
  saveDocument(db, scenes[0]!, doc(LEDGER, 'The rain came after.'))
  saveDocument(db, scenes[1]!, doc(QUIET))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  complete.mockResolvedValue(said({ answer: 'Done.', found: true, citations: [] }))
  ledger = []
  steps = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    // 2026-10-07: every step streams; the fake answers a stream with `complete`'s reply in
    // two pieces, so one queue of replies drives both.
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

describe('runAgent (F-5.22)', () => {
  it('looks things up step by step, shows each step, then answers with verified citations', async () => {
    replies(
      { tool: 'search', args: { query: 'ledger' } },
      { tool: 'read_scene', args: { id: ref(scenes[0]) } },
      {
        answer: 'Under the elm in the north pasture. [1]',
        found: true,
        citations: [{ id: ref(scenes[0]), quote: QUOTE }]
      }
    )
    const result = await run()
    expect(steps.map((s) => s.tool)).toEqual(['search', 'read_scene'])
    expect(steps[0]?.label).toBe('Searching “ledger”…')
    expect(steps[1]?.label).toMatch(/^Reading .+…$/)
    expect(result.steps).toEqual(steps)
    expect(result.answer).toBe('Under the elm in the north pasture. [1]')
    expect(result.query).toMatchObject({
      found: true,
      uncited: false,
      citations: [{ nodeId: scenes[0], scene: 1, quote: QUOTE }]
    })
    expect(result.changes).toEqual([])
    expect(result.dropped).toBe(0)
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 120 })
    expect(ledger.map((row) => row.feature)).toEqual(['agent', 'agent', 'agent'])
    expect(request(0)).toMatchObject({ tier: 'strong', json: true, maxTokens: 1_500 })
    // The open document is in every step; the tool results join as turns.
    const system = request(0).messages[0]?.content ?? ''
    expect(system.startsWith(AGENT_RULES)).toBe(true)
    expect(system).not.toContain(AGENT_EDIT_RULES_V2)
    expect(system).toContain(`Open document ${ref(scenes[0])}:`)
    // F-5.23 (agent.v3): the story-time rule, then the story map with now on the open scene,
    // before the open document. F-9.10: version 4 adds the organise rule.
    expect(result.promptVersion).toBe('agent.v4')
    expect(system).toContain(AGENT_ORGANISE_RULES)
    expect(result.organise).toBeNull()
    expect(system).toContain(AGENT_TIME_RULES)
    expect(system).toContain(STORY_MAP_HEADING)
    expect(system).toMatch(new RegExp(`${ref(scenes[0])} [^\\n]*\\[drafted\\] ▶ NOW`))
    expect(system.indexOf(STORY_MAP_HEADING)).toBeLessThan(system.indexOf('Open document'))
    const third = request(2).messages
    expect(third.at(-2)).toEqual({
      role: 'assistant',
      content: JSON.stringify({ tool: 'read_scene', args: { id: ref(scenes[0]) } })
    })
    expect(third.at(-1)?.content).toContain(LEDGER.slice(0, 40))
  })

  it('drops a citation the document does not hold, strips its marker, and flags a read answer left uncited', async () => {
    replies({
      answer: 'In the mill [1], or the barn [2].',
      found: true,
      citations: [
        { id: ref(scenes[0]), quote: 'Mara burned the ledger' },
        { id: 'n9999', quote: QUOTE }
      ]
    })
    const result = await run()
    expect(result.answer).toBe('In the mill, or the barn.')
    expect(result.dropped).toBe(2)
    expect(result.query).toMatchObject({ found: true, uncited: true, citations: [] })
  })

  it('keeps a cited sheet the project has, so an answer from the author’s notes is not uncited', async () => {
    createEntity(db, { kind: 'character', name: 'Wren', fields: { appearance: 'Grey eyes.' } })
    replies({
      answer: 'Wren has grey eyes [1].',
      found: true,
      citations: [{ sheet: 'Wren' }, { sheet: 'Nobody' }]
    })
    const result = await run()
    expect(result.query).toMatchObject({
      uncited: false,
      citations: [],
      sheets: [{ name: 'Wren', kind: 'character' }]
    })
    expect(result.dropped).toBe(1)
  })

  it('tells the model when a tool or an id names nothing, and keeps going', async () => {
    replies(
      { tool: 'teleport', args: {} },
      { tool: 'read_scene', args: { id: 'n9999' } },
      { answer: 'Not in the book.', found: false, citations: [] }
    )
    const result = await run()
    expect(request(1).messages.at(-1)?.content).toContain('There is no tool "teleport"')
    expect(request(2).messages.at(-1)?.content).toContain('n9999 is not an id')
    expect(result.query).toMatchObject({ found: false, uncited: false })
  })

  it(`answers after ${AGENT_MAX_STEPS} lookups, and says so when the model still wants more`, async () => {
    complete.mockResolvedValue(said({ tool: 'outline', args: {} }))
    const result = await run()
    expect(complete).toHaveBeenCalledTimes(AGENT_MAX_STEPS + 1)
    expect(request(AGENT_MAX_STEPS).messages.at(-1)?.content).toBe(AGENT_FINAL_TURN)
    expect(result.answer).toBe(AGENT_OUT_OF_STEPS)
    expect(steps).toHaveLength(AGENT_MAX_STEPS)
  })

  it('takes a reply that is not JSON as the plain answer', async () => {
    replies('She hid it under the elm.')
    const result = await run()
    expect(result.answer).toBe('She hid it under the elm.')
    expect(result.query).toMatchObject({ found: true, uncited: true })
  })

  it('refuses with DISABLED at Off or with the feature off, before any request', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(run()).rejects.toMatchObject({
      code: 'DISABLED',
      message: 'Assistant lookups and edits needs Use AI turned on (it is off).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 1, features: { ...on.features, agent: false } })
    await expect(run()).rejects.toBeInstanceOf(AiProviderError)
    expect(complete).not.toHaveBeenCalled()
  })

  it('stops the step in flight on a cancel of the run and releases every id', async () => {
    complete.mockImplementation(
      (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener(
            'abort',
            () => reject(new AiCancelledError('The request was stopped.')),
            { once: true }
          )
        })
    )
    const pending = run({ requestId: 'a-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(agentStepRequestId('a-1', 0)).toBe('a-1:step0')
    expect(cancelInflight('a-1')).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(AiCancelledError)
    expect(inflightCount()).toBe(0)
  })
})

describe('runAgent, write runs (F-5.22)', () => {
  it('carries the edit rules and offers the edits it can place, dropping the rest', async () => {
    replies({
      answer: 'I tightened the line and added a beat.',
      found: true,
      citations: [],
      edits: [
        {
          edit: 'text',
          id: ref(scenes[0]),
          find: 'The rain came after.',
          replace: 'Rain followed.'
        },
        { edit: 'text', id: ref(scenes[0]), find: 'ledger', replace: 'book' },
        { edit: 'insert', id: ref(scenes[1]), after: '', text: 'The lantern guttered.' },
        { edit: 'fly', id: ref(scenes[0]) }
      ]
    })
    const result = await run({ access: 'write' })
    expect(request(0).messages[0]?.content).toContain(AGENT_EDIT_RULES_V2)
    expect(result.query).toBeNull()
    expect(result.changes.map((c) => c.edit)).toEqual([
      {
        kind: 'text',
        nodeId: scenes[0],
        title: loadAgentProject(db).titleOf(scenes[0] ?? ''),
        find: 'The rain came after.',
        replace: 'Rain followed.',
        brief: ''
      },
      {
        kind: 'insert',
        nodeId: scenes[1],
        title: loadAgentProject(db).titleOf(scenes[1] ?? ''),
        after: '',
        text: 'The lantern guttered.',
        brief: '',
        words: 0
      }
    ])
    // "ledger" occurs twice; "fly" is no edit.
    expect(result.dropped).toBe(2)
  })

  it('takes prose as intents (agent.v2): an insertion keeps an anchor the scene lacks, a rewrite keeps its brief', async () => {
    replies({
      answer: 'I will add the beat and rework the line.',
      edits: [
        {
          edit: 'insert',
          id: ref(scenes[0]),
          after: 'A sentence the scene does not hold.',
          brief: 'Tomas looks at the elm and says nothing.',
          words: 5000
        },
        {
          edit: 'text',
          id: ref(scenes[0]),
          find: 'The rain came after.',
          brief: 'Make the rain arrive with a sound.'
        },
        { edit: 'insert', id: ref(scenes[1]), after: '' }
      ]
    })
    const result = await run({ access: 'write' })
    const title = loadAgentProject(db).titleOf(scenes[0] ?? '')
    expect(result.changes).toEqual([
      {
        edit: {
          kind: 'insert',
          nodeId: scenes[0],
          title,
          after: 'A sentence the scene does not hold.',
          text: '',
          brief: 'Tomas looks at the elm and says nothing.',
          words: 900
        },
        violation: null
      },
      {
        edit: {
          kind: 'text',
          nodeId: scenes[0],
          title,
          find: 'The rain came after.',
          replace: '',
          brief: 'Make the rain arrive with a sound.'
        },
        violation: null
      }
    ])
    // An insertion with neither prose nor a brief is no edit.
    expect(result.dropped).toBe(1)
  })

  it('flags an edit whose prose breaks the author rules, and never edits in a read run', async () => {
    setAuthorRules(db, { rules: '', bannedPhrases: ['delve'] })
    bumpVoiceVersion()
    const edits = [
      { edit: 'text', id: ref(scenes[0]), find: 'The rain came after.', replace: 'We delve on.' }
    ]
    replies({ answer: 'Changed.', edits }, { answer: 'Read only.', edits })
    const write = await run({ access: 'write' })
    expect(write.changes[0]?.violation).toMatch(/delve/)
    const read = await run()
    expect(read.changes).toEqual([])
    expect(read.dropped).toBe(1)
  })
})

describe('fitAgentPrompt', () => {
  it('drops the oldest tool results first, then the oldest history', () => {
    const big = 'x'.repeat(inputBudget('agent') * 4 + 100)
    const built = fitAgentPrompt({
      access: 'read',
      voice: null,
      map: null,
      focus: null,
      history: [{ role: 'user', content: 'old question' }],
      message: 'Now?',
      steps: [
        { call: '{"tool":"outline"}', result: big },
        { call: '{"tool":"tags"}', result: 'Tone: grim' }
      ],
      final: false
    })
    const contents = built.messages.map((m) => m.content)
    expect(contents).toContain(AGENT_DROPPED_RESULT)
    expect(contents).toContain('Tone: grim')
    expect(contents).toContain('old question')
    expect(estimateTokens(contents.join('\n'))).toBeLessThanOrEqual(inputBudget('agent'))
  })
})

/** The truncated reply of the author's report: the JSON stops mid-draft at the output cap. */
const CUT_OFF_REPLY =
  '{"answer": "I\'ve inserted a draft…", "edits": [{ "edit": "insert", "id": "n3", ' +
  '"after": "Stunned silence.", "text": "Aos\'s pen stopped…That\'s what'

const cutOff = (text = CUT_OFF_REPLY): CompletionResult => ({
  text,
  model: 'gpt-5.4',
  usage: { inputTokens: 500, outputTokens: 1500, reasoningTokens: 1200 },
  finishReason: 'length'
})

describe('runAgent, replies that cannot be used (2026-10-07)', () => {
  it('never shows a reply cut off mid-JSON: asks once more, briefly, with a larger cap, and caches neither', async () => {
    complete.mockResolvedValueOnce(cutOff())
    replies({ answer: 'Short answer.', found: true, citations: [] })
    const answers: string[] = []
    let resets = 0
    const notes: [string, string][] = []
    const result = await runAgent(
      db,
      deps,
      {
        nodeId: scenes[0] ?? null,
        message: 'Add a beat.',
        history: [],
        access: 'write',
        focus: { beforeCaret: '', selection: '' },
        requestId: 'r-9'
      },
      () => undefined,
      {
        answer: (delta) => answers.push(delta),
        reset: () => resets++,
        note: (id, note) => notes.push([id, note])
      }
    )
    expect(result.answer).toBe('Short answer.')
    expect(complete).toHaveBeenCalledTimes(2)
    expect(request(0).maxTokens).toBe(1_500)
    expect(request(1).maxTokens).toBe(3_000)
    expect(request(1).messages.at(-1)?.content).toBe(AGENT_RETRY_TURN)
    // The cut-off reply's answer had streamed, so the chat was told to drop it.
    expect(resets).toBe(1)
    expect(answers.join('')).toBe("I've inserted a draft…Short answer.")
    expect(notes).toEqual([
      ['r-9:step0', expect.stringMatching(/cut off .*1200 reasoning.*asked again/)]
    ])
    // The cut-off reply is never served again: the same step asks the provider anew; the
    // retry's good answer is.
    complete.mockResolvedValueOnce(cutOff())
    const again = await run({ message: 'Add a beat.', access: 'write' })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(again.answer).toBe('Short answer.')
  })

  it('says the reply was cut off, with the request id, when the retry fails too', async () => {
    complete.mockResolvedValueOnce(cutOff()).mockResolvedValueOnce(said('{"answer": "Still'))
    const result = await run({ requestId: 'r-10' })
    expect(result.answer).toBe(`${AGENT_CUT_OFF_MESSAGE} (Request r-10:step0:retry)`)
    expect(result.answer).not.toContain('{')
    expect(result.changes).toEqual([])
    expect(result.query).toBeNull()
  })

  it('streams the answer text as it arrives', async () => {
    replies({ answer: 'Under the "elm",\nin the north.', found: true, citations: [] })
    const answers: string[] = []
    await runAgent(
      db,
      deps,
      {
        nodeId: null,
        message: 'Where?',
        history: [],
        access: 'read',
        focus: { beforeCaret: '', selection: '' }
      },
      () => undefined,
      { answer: (delta) => answers.push(delta) }
    )
    expect(answers.join('')).toBe('Under the "elm",\nin the north.')
  })
})

describe('AnswerStream', () => {
  it('hands back the answer string only, unescaped, across any split', () => {
    const json = JSON.stringify({ found: true, answer: 'Say "hi"\\ now\né', citations: [] })
    for (let size = 1; size <= 5; size++) {
      const stream = new AnswerStream()
      let out = ''
      for (let i = 0; i < json.length; i += size) out += stream.feed(json.slice(i, i + size))
      expect(out).toBe('Say "hi"\\ now\né')
    }
    expect(new AnswerStream().feed('{"tool":"search","args":{"query":"x"}}')).toBe('')
  })
})

describe('readAgentReply', () => {
  it('tells a cut-off or broken JSON reply from a plain-prose answer', () => {
    expect(readAgentReply(CUT_OFF_REPLY, 'length')).toEqual({ kind: 'broken', reason: 'cutOff' })
    expect(readAgentReply('{"answer": "Hal', 'stop')).toEqual({
      kind: 'broken',
      reason: 'unreadable'
    })
    expect(readAgentReply('', null)).toEqual({ kind: 'broken', reason: 'unreadable' })
    expect(readAgentReply('Plain words, cut', 'length')).toEqual({
      kind: 'broken',
      reason: 'cutOff'
    })
    expect(readAgentReply('She hid it under the elm.', 'stop')).toMatchObject({
      kind: 'answer',
      answer: 'She hid it under the elm.'
    })
    expect(readAgentReply('{"tool":"tags"}', 'stop')).toMatchObject({ kind: 'tool' })
  })
})

describe('the organise request (F-9.10, agent.v4)', () => {
  it('reads the scopes it knows and the instruction, leniently', () => {
    expect(
      readOrganiseRequest({ scope: ['tags', 'planets', 'tags'], instruction: ' Tidy. ' })
    ).toEqual({
      scope: ['tags'],
      instruction: 'Tidy.'
    })
    expect(readOrganiseRequest(true)).toEqual({ instruction: '', scope: [] })
    expect(readOrganiseRequest({})).toEqual({ instruction: '', scope: [] })
    expect(readOrganiseRequest(undefined)).toBeNull()
    expect(readOrganiseRequest('organise')).toBeNull()
    expect(parseAgentReply('{"answer":"I will.","organise":{"scope":[]}}')).toMatchObject({
      kind: 'answer',
      organise: { scope: [] }
    })
  })

  it('comes back on the answer of a run', async () => {
    replies({
      answer: 'I will plan a tidier story bible.',
      found: true,
      organise: { scope: ['sheets'], instruction: 'Merge the duplicate sheets.' }
    })
    const result = await run()
    expect(result.organise).toEqual({
      scope: ['sheets'],
      instruction: 'Merge the duplicate sheets.'
    })
  })
})

describe('parseAgentReply', () => {
  it('reads a tool call, a fenced answer, and plain text', () => {
    expect(parseAgentReply('{"tool":"tags"}')).toEqual({ kind: 'tool', tool: 'tags', args: {} })
    expect(parseAgentReply('```json\n{"answer":"Yes.","found":false}\n```')).toEqual({
      kind: 'answer',
      answer: 'Yes.',
      found: false,
      citations: [],
      edits: []
    })
    expect(parseAgentReply('Just words.')).toMatchObject({ kind: 'answer', answer: 'Just words.' })
  })
})

describe('the agent tools (F-5.22)', () => {
  it('outlines the project with refs and word counts, and pages through a long scene', () => {
    saveDocument(db, scenes[1]!, doc('a'.repeat(7_000)))
    const project = loadAgentProject(db)
    const outline = runAgentTool(project, null, 'outline', {}).result
    expect(outline).toContain(`${ref(scenes[0])} `)
    // F-5.23: each manuscript document's progress after its word count.
    expect(outline).toMatch(/words, (planned|drafted|revised)\)/)
    const first = runAgentTool(project, null, 'read_scene', { id: ref(scenes[1]) })
    expect(first.result).toContain('characters 0–6000 of 7000')
    expect(first.result).toContain('"from":6000')
    const rest = runAgentTool(project, null, 'read_scene', { id: ref(scenes[1]), from: 6000 })
    expect(rest.result).toContain('characters 6000–7000 of 7000')
  })

  it('reads notes, sheets, the sheet list, and the tags', () => {
    setSceneMeta(db, scenes[0]!, { ...emptySceneMeta(), synopsis: 'Mara hides the copy.' })
    saveNotes(db, scenes[0]!, doc('Keep the elm visible.'))
    createEntity(db, { kind: 'character', name: 'Mara Vell', fields: { age: '34' } })
    createTag(db, { name: 'grim', category: 'tone' })
    const project = loadAgentProject(db)
    expect(runAgentTool(project, null, 'read_notes', { id: ref(scenes[0]) }).result).toBe(
      `${project.titleOf(scenes[0]!)} (${NOTES_ARE_PLANS}):\n` +
        'Synopsis: Mara hides the copy.\nNotes:\nKeep the elm visible.'
    )
    const sheet = runAgentTool(project, null, 'read_sheet', { name: 'mara' })
    expect(sheet.step.label).toBe('Reading Mara Vell’s sheet…')
    expect(sheet.result).toContain('age (Age): 34')
    expect(runAgentTool(project, null, 'list_sheets', { kind: 'character' }).result).toContain(
      'Mara Vell'
    )
    expect(runAgentTool(project, null, 'tags', {}).result).toContain('grim')
  })

  it('says where every source sits in story time (F-5.23)', () => {
    createEntity(db, {
      kind: 'character',
      name: 'Pell',
      fields: { background: 'Dies in the war.' }
    })
    // Now is the second scene: the first is before it, the third after it.
    const project = loadAgentProject(db, scenes[1])
    expect(project.time.nowId).toBe(scenes[1])
    const read = (id: string | undefined): string =>
      runAgentTool(project, null, 'read_scene', { id: ref(id) }).result
    expect(read(scenes[0])).toContain('(before now: has happened)')
    expect(read(scenes[1])).toContain('(now: the scene the author is at)')
    const outline = runAgentTool(project, null, 'outline', {}).result
    expect(outline).toMatch(new RegExp(`${ref(scenes[1])} [^\n]*▶ NOW`))
    const sheet = runAgentTool(project, null, 'read_sheet', { name: 'Pell' }).result
    expect(sheet.split('\n')[0]).toBe(`Pell (character; ${SHEETS_ARE_PLANS})`)
    const search = runAgentTool(project, null, 'search', { query: 'ledger Pell' }).result
    expect(search).toContain(
      `${ref(scenes[0])} ${project.titleOf(scenes[0]!)} (before now: has happened)`
    )
    expect(search).toContain(`Sheets (${SHEETS_ARE_PLANS}): Pell (character)`)
  })

  it('puts now at the latest written scene when no manuscript scene is open (F-5.23)', () => {
    expect(loadAgentProject(db, null).time).toMatchObject({ nowId: scenes[1], basis: 'latest' })
    const later = runAgentTool(loadAgentProject(db, scenes[0]), null, 'read_scene', {
      id: ref(scenes[1])
    }).result
    expect(later).toContain('(after now: has not happened yet)')
  })

  it('counts a passage the way quotes are matched', () => {
    expect(occurrencesOf('He said “stop.”  He said "stop."', 'said "stop."')).toBe(2)
    expect(occurrencesOf('nothing here', 'missing')).toBe(0)
  })
})

describe('resolveAgentEdit (F-5.22)', () => {
  it('resolves structure, sheet, tag, and delete edits and refuses what it cannot place', () => {
    createEntity(db, { kind: 'character', name: 'Mara Vell', fields: { age: '34' } })
    const project = loadAgentProject(db)
    const chapter = project.rows.find((row) => row.id === project.byId.get(scenes[0]!)?.parentId)
    if (!chapter) throw new Error('no chapter')
    const chapterRef = project.refOf.get(chapter.id) ?? ''
    expect(
      resolveAgentEdit(project, {
        edit: 'create',
        level: 'scene',
        in: chapterRef,
        after: ref(scenes[0]),
        title: 'The pasture',
        text: 'Night.'
      })
    ).toMatchObject({ edit: { kind: 'create', parentId: chapter.id, afterId: scenes[0] } })
    expect(
      resolveAgentEdit(project, { edit: 'sheet', name: 'Mara', field: 'age', text: '35' })
    ).toMatchObject({ edit: { kind: 'sheet', field: 'age', before: '34', after: '35' } })
    expect(
      resolveAgentEdit(project, { edit: 'sheet', name: 'Mara', field: 'rules', text: 'x' })
    ).toMatchObject({ error: '"rules" is not a character field' })
    expect(
      resolveAgentEdit(project, { edit: 'rename', id: ref(scenes[0]), title: 'The elm' })
    ).toMatchObject({ edit: { kind: 'rename', after: 'The elm' } })
    expect(
      resolveAgentEdit(project, { edit: 'merge', id: ref(scenes[1]), into: ref(scenes[0]) })
    ).toMatchObject({ edit: { kind: 'merge', intoId: scenes[0] } })
    expect(
      resolveAgentEdit(project, { edit: 'split', id: ref(scenes[0]), at: 'The rain came' })
    ).toMatchObject({ edit: { kind: 'split', at: 'The rain came' } })
    expect(
      resolveAgentEdit(project, { edit: 'tag', id: ref(scenes[0]), tag: 'Grim Mood' })
    ).toMatchObject({ edit: { kind: 'tag', tag: 'grim-mood', add: true } })
    expect(resolveAgentEdit(project, { edit: 'delete', sheet: 'Mara Vell' })).toMatchObject({
      edit: { kind: 'delete', target: 'sheet', name: 'Mara Vell' }
    })
    const root = project.rows.find((row) => row.parentId === null)
    expect(resolveAgentEdit(project, { edit: 'delete', id: ref(root?.id) })).toMatchObject({
      error: 'not a deletable id'
    })
    expect(
      resolveAgentEdit(project, { edit: 'move', id: ref(scenes[1]), in: ref(scenes[0]) })
    ).toMatchObject({ error: '"in" is not a folder' })
  })
})
