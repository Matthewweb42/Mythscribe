import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import type { AiSceneCard } from '@shared/sceneCard'
import type { TiptapNodeT } from '@shared/tiptap'
import { TODO_AI_ITEMS_MAX, TODO_PASS_CHUNKS_MAX, continuityTodoId } from '@shared/todo'
import { node, todoItem } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { upsertSummary } from '../document/summaryStore'
import { createEntity } from '../entity/entityStore'
import { listTodo, settleTodo } from '../knowledge/todoStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getTodoPassState, setAiSettings, setTodoPassState } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider } from './providers/types'
import type { AiRequestDeps } from './request'
import {
  buildTodoInput,
  parseTodoAnswer,
  parseTodoSuggestAnswer,
  runTodoPass,
  suggestTodo,
  todoCheckView,
  todoChunks,
  type TodoAnswerContext,
  type TodoPassInput
} from './todoPass'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 9, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

const FILLER =
  ' The rain kept on through the evening, and the lamps along the quay burned low while the ' +
  'boats knocked against the posts and nobody on the landing said a word about the weather, ' +
  'not the ferryman, not the girl with the lantern, and not the old man who sold the tickets.'

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scenes: string[]

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const card = (over: Partial<AiSceneCard> = {}): AiSceneCard => ({
  where: 'the quay',
  when: 'the first night',
  pov: 'Mara',
  changed: 'Mara learns the Hollowing swallows sound.',
  ...over
})

function summarize(nodeId: string, value: AiSceneCard): void {
  upsertSummary(db, {
    nodeId,
    summary: 'A scene.',
    keyPoints: [],
    characters: [],
    contentHash: 'h',
    promptVersion: 'summary.v4',
    model: 'gpt-5.4-mini',
    truncated: false,
    createdAt: NOW.toISOString(),
    card: value
  })
}

function answers(body: unknown): void {
  complete.mockResolvedValueOnce({
    text: JSON.stringify(body),
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 900, outputTokens: 200 }
  })
}

const contents = (): unknown[] =>
  db
    .select({ id: node.id, content: node.content })
    .from(node)
    .all()
    .map((row) => [row.id, row.content])

const rows = (): (typeof todoItem.$inferSelect)[] => db.select().from(todoItem).all()

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-todopass-'))
  session = createSeededProject(projectFolderFor(tmp, 'Todo'), 'Todo', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc(`Mara reached the Hollowing at dusk.${FILLER}`))
  saveDocument(db, scenes[1]!, doc(`Three days later the ferry was gone.${FILLER}`))
  summarize(scenes[0]!, card())
  summarize(scenes[1]!, card({ when: 'three days later', changed: 'The ferry is gone.' }))
  setAiSettings(db, { ...defaultAiSettings(), dial: 1, chatMode: 'ask' })
  complete = vi.fn<Complete>()
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

describe('runTodoPass (F-9.16)', () => {
  it('refuses with Use AI off and sends nothing', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(runTodoPass(db, deps)).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('sends the scene cards, stores the gaps it flags, and never touches a scene', async () => {
    const before = contents()
    answers({
      items: [
        {
          type: 'term',
          about: 'Hollowing',
          scene: 'S1',
          why: 'The cards lean on it, but nothing says what it is.',
          suggestions: ['A sinkhole that swallows sound', 'An old quarry the town avoids']
        },
        { type: 'timeline', about: 'the three days', scene: 'S2', why: 'Time jumps.' },
        { type: 'question', about: 'the ferry', scene: 'S9', why: 'No such scene was sent.' },
        { type: 'mystery', about: 'Mara', scene: 'S1', why: 'Not a type.' }
      ],
      resolved: []
    })
    const result = await runTodoPass(db, deps, { requestId: 'r1' })
    expect(result).toMatchObject({ requested: true, added: 2, resolved: 0 })

    const sent = complete.mock.calls[0]?.[0]
    expect(sent?.messages[0]?.content).toMatch(/^You are the To do check/)
    expect(sent?.messages[1]?.content).toContain('S1 "Scene 1" · the first night · POV Mara')
    expect(ledger.map((entry) => entry.feature)).toEqual(['todo'])

    const items = listTodo(db).items.filter((item) => item.source === 'ai')
    const term = items.find((item) => item.rule === 'term')
    expect(term).toMatchObject({
      kind: 'undefined',
      subject: 'Hollowing',
      nodeId: scenes[0],
      quote: 'Mara reached the Hollowing at dusk.',
      target: { kind: 'newRecord', category: 'world', name: 'Hollowing' },
      suggestions: ['A sinkhole that swallows sound', 'An old quarry the town avoids'],
      suggested: true
    })
    expect(items.find((item) => item.rule === 'timeline')).toMatchObject({
      kind: 'gap',
      target: { kind: 'notes', nodeId: scenes[1] },
      quote: null,
      suggested: false
    })
    expect(getTodoPassState(db)).toMatchObject({ lastPassAt: NOW.toISOString() })
    expect(contents()).toEqual(before)
  })

  it('sends nothing when the book is unchanged since the last check', async () => {
    answers({ items: [], resolved: [] })
    await runTodoPass(db, deps)
    const again = await runTodoPass(db, deps)
    expect(again).toEqual({ requested: false, added: 0, resolved: 0, costUsd: 0 })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when no scene has a card', async () => {
    const empty = createSeededProject(projectFolderFor(tmp, 'Empty'), 'Empty', 'novel')
    try {
      setAiSettings(empty.connection.orm, { ...defaultAiSettings(), dial: 1 })
      const result = await runTodoPass(empty.connection.orm, deps)
      expect(result.requested).toBe(false)
      expect(complete).not.toHaveBeenCalled()
    } finally {
      empty.close()
    }
  })

  it('never flags a settled item again, and drops a gap the sheet already answers', async () => {
    const mara = createEntity(db, {
      kind: 'character',
      name: 'Mara',
      fields: { goals: 'Find her brother.' }
    }).entity
    answers({
      items: [{ type: 'term', about: 'Hollowing', scene: 'S1', why: 'Unexplained.' }],
      resolved: []
    })
    await runTodoPass(db, deps)
    const [first] = listTodo(db).items.filter((item) => item.source === 'ai')
    settleTodo(db, first!.id, 'dismissed')

    setTodoPassState(db, { lastPassHash: null })
    answers({
      items: [
        { type: 'term', about: 'hollowing', scene: 'S1', why: 'Unexplained again.' },
        { type: 'motivation', about: 'Mara', scene: 'S1', why: 'Why does she go?' }
      ],
      resolved: []
    })
    const result = await runTodoPass(db, deps)
    expect(result.added).toBe(0)
    expect(rows().filter((row) => row.entityId === mara.id)).toEqual([])
  })

  it('points a motivation at the character’s blank Goals field', async () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    answers({
      items: [{ type: 'motivation', about: 'Mara', scene: 'S2', why: 'Why does she stay?' }],
      resolved: []
    })
    await runTodoPass(db, deps)
    expect(listTodo(db).items.find((item) => item.rule === 'motivation')).toMatchObject({
      entityId: mara.id,
      target: { kind: 'field', entityId: mara.id, field: 'goals' },
      targetLabel: 'Mara › Goals / motivations'
    })
  })

  it('drops only the open AI items the answer resolved', async () => {
    answers({
      items: [
        { type: 'term', about: 'Hollowing', scene: 'S1', why: 'Unexplained.' },
        { type: 'question', about: 'the ferry', scene: 'S2', why: 'Where did it go?' }
      ],
      resolved: []
    })
    await runTodoPass(db, deps)
    const now = Date.now()
    db.insert(todoItem)
      .values({
        id: 'local-1',
        key: 'emptyRecord:x',
        kind: 'undefined',
        rule: 'emptyRecord',
        source: 'local',
        subject: 'Someone',
        why: 'Empty.',
        target: '{"kind":"none"}',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString()
      })
      .run()
    const input = buildTodoInput(db)
    expect(input.listed.filter((line) => /^A\d /u.test(line))).toHaveLength(2)

    setTodoPassState(db, { lastPassHash: null })
    answers({ items: [], resolved: ['A1', 'A9', 'local-1'] })
    const result = await runTodoPass(db, deps)
    expect(result.resolved).toBe(1)
    const left = rows().filter((row) => row.status === 'open')
    expect(left.map((row) => row.id)).toContain('local-1')
    expect(left.filter((row) => row.source === 'ai')).toHaveLength(1)
  })

  it('keeps at most the cap of items and refuses an answer that is not JSON', async () => {
    answers({
      items: Array.from({ length: TODO_AI_ITEMS_MAX + 4 }, (_, at) => ({
        type: 'question',
        about: `Question ${at}`,
        scene: 'S1',
        why: 'Open.'
      })),
      resolved: []
    })
    expect((await runTodoPass(db, deps)).added).toBe(TODO_AI_ITEMS_MAX)

    setTodoPassState(db, { lastPassHash: null })
    complete.mockResolvedValueOnce({
      text: 'not json',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 1, outputTokens: 1 }
    })
    await expect(runTodoPass(db, deps)).rejects.toMatchObject({ code: 'PROVIDER' })
  })
})

describe('parseTodoAnswer', () => {
  const context: TodoAnswerContext = {
    scenes: new Map([['s1', 'n1']]),
    listed: new Map([['a1', 'row-1']]),
    keys: new Set(['term:known']),
    entities: [],
    categories: [],
    quoteOf: () => null
  }

  it('maps each type to its kind, cuts the suggestions, and skips known keys', () => {
    const parsed = parseTodoAnswer(
      JSON.stringify({
        items: [
          {
            type: 'rule',
            about: 'The Hush',
            scene: 's1',
            why: 'w',
            suggestions: ['a', 'b', 'c', 'd']
          },
          { type: 'question', about: 'The letter', scene: 'S1', why: 'w' },
          { type: 'term', about: 'Known', scene: 'S1', why: 'w' },
          { type: 'term', about: '', scene: 'S1', why: 'w' }
        ],
        resolved: ['a1', 'A1', 'b2']
      }),
      context
    )
    expect(parsed.items.map((item) => [item.rule, item.kind, item.suggestions.length])).toEqual([
      ['rule', 'gap', 3],
      ['question', 'looseEnd', 0]
    ])
    expect(parsed.resolved).toEqual(['row-1'])
  })

  it('refuses an answer without an items list', () => {
    expect(() => parseTodoAnswer('{"resolved":[]}', context)).toThrow()
  })
})

describe('todoChunks', () => {
  it('cuts a long book into at most three windows, keeping the newest scenes', () => {
    const input: TodoPassInput = {
      digest: [],
      threads: [],
      listed: [],
      listedIds: new Map(),
      settled: [],
      scenes: Array.from({ length: 1_000 }, (_, at) => ({
        label: `S${at + 1}`,
        nodeId: `n${at + 1}`,
        line: `S${at + 1} ${'x'.repeat(190)}`
      }))
    }
    const chunks = todoChunks(input)
    expect(chunks).toHaveLength(TODO_PASS_CHUNKS_MAX)
    expect(chunks.at(-1)?.scenes.at(-1)?.label).toBe('S1000')
    expect(chunks[0]?.scenes[0]?.label).not.toBe('S1')
    const labels = chunks.flatMap((chunk) =>
      chunk.scenes.map((scene) => Number(scene.label.slice(1)))
    )
    expect(labels).toEqual([...labels].sort((a, b) => a - b))
  })

  it('is empty without a scene line', () => {
    expect(
      todoChunks({
        digest: [],
        threads: [],
        listed: [],
        listedIds: new Map(),
        settled: [],
        scenes: []
      })
    ).toEqual([])
  })
})

describe('todoCheckView', () => {
  const context = { allowed: true, source: 'ownKey' as const, model: 'gpt-5.4-mini', pricing: null }

  it('is idle when AI may not run', () => {
    expect(todoCheckView(db, { ...context, allowed: false })).toMatchObject({
      allowed: false,
      estimateUsd: null
    })
  })

  it('estimates a run, and reads fresh after one on the same book', async () => {
    const view = todoCheckView(db, context)
    expect(view.allowed).toBe(true)
    expect(view.estimateUsd).toBeGreaterThan(0)
    answers({ items: [], resolved: [] })
    await runTodoPass(db, deps)
    expect(todoCheckView(db, context)).toMatchObject({ fresh: true, lastAt: NOW.toISOString() })
  })
})

describe('suggestTodo (F-9.16)', () => {
  async function oneItem(): Promise<string> {
    answers({
      items: [{ type: 'question', about: 'the ferry', scene: 'S2', why: 'Where did it go?' }],
      resolved: []
    })
    await runTodoPass(db, deps)
    const id = listTodo(db).items.find((item) => item.rule === 'question')?.id
    if (id === undefined) throw new Error('no item')
    return id
  }

  it('asks once, stores the options on the item, and answers them from the row after', async () => {
    const id = await oneItem()
    const before = contents()
    answers({
      suggestions: ['It sank in the storm.', 'Pell sold it.', '', 'It sank in the storm.']
    })
    const first = await suggestTodo(db, deps, { id, requestId: 's1' })
    expect(first).toMatchObject({
      requested: true,
      suggestions: ['It sank in the storm.', 'Pell sold it.']
    })
    const sent = complete.mock.calls.at(-1)?.[0]
    expect(sent?.messages[0]?.content).toMatch(/^You are the To do suggestions/)
    expect(sent?.messages[1]?.content).toContain('Three days later the ferry was gone.')

    const again = await suggestTodo(db, deps, { id })
    expect(again).toEqual({ ...first, requested: false, costUsd: 0 })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(listTodo(db).items.find((item) => item.id === id)).toMatchObject({ suggested: true })
    expect(contents()).toEqual(before)
  })

  it('refuses a settled item and a contradiction', async () => {
    const id = await oneItem()
    settleTodo(db, id, 'done')
    await expect(suggestTodo(db, deps, { id })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(suggestTodo(db, deps, { id: continuityTodoId('f1') })).rejects.toMatchObject({
      code: 'VALIDATION'
    })
    await expect(suggestTodo(db, deps, { id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads an answer with no usable option as a provider failure', () => {
    expect(() => parseTodoSuggestAnswer('{"suggestions":[""]}')).toThrow()
    expect(() => parseTodoSuggestAnswer('nope')).toThrow()
    expect(parseTodoSuggestAnswer('{"suggestions":["a","b","c","d"]}')).toEqual(['a', 'b', 'c'])
  })
})
