import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, inputBudget, priceFor } from '@shared/ai'
import { AGENT_MAX_STEPS, type AgentStep } from '@shared/agent'
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
  agentStepRequestId,
  fitAgentPrompt,
  parseAgentReply,
  runAgent,
  type AgentInput
} from './agent'
import { loadAgentProject, occurrencesOf, resolveAgentEdit, runAgentTool } from './agentTools'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import { AGENT_FINAL_TURN, AGENT_RULES, AGENT_EDIT_RULES } from './prompts/agent.v1'
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
    expect(system).not.toContain(AGENT_EDIT_RULES)
    expect(system).toContain(`Open document ${ref(scenes[0])}:`)
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
    expect(request(0).messages[0]?.content).toContain(AGENT_EDIT_RULES)
    expect(result.query).toBeNull()
    expect(result.changes.map((c) => c.edit)).toEqual([
      {
        kind: 'text',
        nodeId: scenes[0],
        title: loadAgentProject(db).titleOf(scenes[0] ?? ''),
        find: 'The rain came after.',
        replace: 'Rain followed.'
      },
      {
        kind: 'insert',
        nodeId: scenes[1],
        title: loadAgentProject(db).titleOf(scenes[1] ?? ''),
        after: '',
        text: 'The lantern guttered.'
      }
    ])
    // "ledger" occurs twice; "fly" is no edit.
    expect(result.dropped).toBe(2)
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
    expect(outline).toMatch(/words\)/)
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
