import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MAX_CONVERSATIONS,
  CHAT_TITLE_MAX,
  titleFor,
  type Conversation,
  type Conversations
} from '@shared/chat'
import { defaultAiSettings } from '@shared/aiSettings'
import type { EditChange } from '@shared/editPass'
import type { RouteAction } from '@shared/assistantRoute'
import type {
  AiAgentResult,
  AiScribeResult,
  AiWhatNextResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import { RECAP_SCENE_QUESTION, WHAT_NEXT_QUESTION } from '@shared/quickActions'
import { WHAT_NEXT_CHAR_BUDGET } from '@shared/whatNext'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { ghostOf } from '@renderer/features/editor/ghostText'
import { locateText } from '@renderer/features/editor/locateText'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import {
  registerTrackedEditor,
  resetEditPassStore
} from '@renderer/features/editPass/editPassStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  costPartsOf,
  NEW_CONVERSATION_TITLE,
  NO_SCENE_MESSAGE,
  PLAN_NO_EDITS_MESSAGE,
  OPEN_SCENE_TIMEOUT_MS,
  PASSAGE_GONE_MESSAGE,
  resetAssistantStore,
  TRACKED_TEXT_CHANGED,
  useAssistantStore
} from './assistantStore'
import { resetAiActivityStore, useAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { resetProposalStore } from './proposalStore'

interface PendingSet {
  /** The zod input shape: a stored turn written before F-5.7 carries no `query`. */
  value: Input<'conversations:set'>
  resolve: () => void
  reject: (err: Error) => void
}
interface PendingQuery {
  input: Input<'ai:agent'>
  resolve: (result: AiAgentResult) => void
  reject: (err: Error) => void
}
/** Notes redesign phase 1: a v1 chat turn's request to Ms Scribe, answered when the test says so. */
interface PendingScribe {
  input: Input<'ai:scribe'>
  resolve: (result: AiScribeResult) => void
  reject: (err: Error) => void
}
interface PendingWhatNext {
  input: Input<'ai:whatNext'>
  resolve: (result: AiWhatNextResult) => void
  reject: (err: Error) => void
}

/** What the fake `ai:agentDraft` drafts for an agent's insertion (2026-10-07). */
const DRAFTED = 'Rain followed her up the ridge.'

let sets: PendingSet[]
let whatNexts: PendingWhatNext[]
let queries: PendingQuery[]
let scribes: PendingScribe[]
/** The note versions and pages Undo asked main to restore and delete (notes redesign phase 1). */
let restoredVersions: string[]
let deletedPages: string[]
let settles: Input<'proposal:settle'>[]
/** The request ids `ai:cancel` was asked to stop. */
let cancels: string[]
/** What the fake router picks for every message (F-5.19); chat unless a test says otherwise. */
let routeAction: RouteAction
/** The `ai:agentStep` listener the store registered, if any (F-5.22). */
let stepListener: ((payload: EventPayload<'ai:agentStep'>) => void) | null
let unsubscribed: number
/** The tree renames the agent's edits asked for (F-5.22). */
let renames: Input<'tree:rename'>[]
/** F-9.15: what the chat logged in Changes, and the log's undos it asked for. */
let recorded: Input<'changes:record'>[]
let logUndos: string[]
/** F-16.26: the sheet lines the chat added and took back. */
let addedLines: Input<'record:addLine'>[]
let removedLines: Input<'record:removeLine'>[]
/** Notes fixes (2026-10-15): Ms Scribe's tracked changes main holds, their settles, the listener. */
let trackedRows: EditChange[]
let trackedSettles: Input<'editPass:settle'>[]
let trackedListener: ((payload: EventPayload<'scribe:trackedSettled'>) => void) | null

/**
 * `conversations:get` answers with `stored`; `ai:route` picks `routeAction` locally at once;
 * `conversations:set`, `ai:agent`, and `ai:whatNext` resolve only when the test says so;
 * `proposal:settle` records; the step listener is captured.
 */
function deferredClient(stored: Conversations): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'conversations:get') return stored as Output<C>
      if (channel === 'conversations:set') {
        const value = input as Input<'conversations:set'>
        return new Promise<Output<C>>((resolve, reject) => {
          sets.push({ value, resolve: () => resolve(value as Output<C>), reject })
        })
      }
      if (channel === 'ai:agent') {
        return new Promise<Output<C>>((resolve, reject) => {
          queries.push({
            input: input as Input<'ai:agent'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'ai:scribe') {
        return new Promise<Output<C>>((resolve, reject) => {
          scribes.push({
            input: input as Input<'ai:scribe'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'notebook:restoreVersion') {
        restoredVersions.push((input as Input<'notebook:restoreVersion'>).versionId)
        return null as Output<C>
      }
      if (channel === 'notebook:delete') {
        deletedPages.push((input as Input<'notebook:delete'>).id)
        return null as Output<C>
      }
      if (channel === 'ai:whatNext') {
        return new Promise<Output<C>>((resolve, reject) => {
          whatNexts.push({
            input: input as Input<'ai:whatNext'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'proposal:settle') {
        settles.push(input as Input<'proposal:settle'>)
        return null as Output<C>
      }
      if (channel === 'ai:route') {
        const { requestId } = input as Input<'ai:route'>
        return {
          ok: true,
          action: routeAction,
          instruction: null,
          routedBy: 'local',
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          cached: false,
          model: null,
          requestId
        } as Output<C>
      }
      if (channel === 'tree:rename') {
        const rename = input as Input<'tree:rename'>
        renames.push(rename)
        const node = treeFixture.find((n) => n.id === rename.id)
        if (!node) throw new Error('unknown node')
        return { ...node, title: rename.title } as Output<C>
      }
      if (channel === 'entity:update') {
        const { id, fields } = input as Input<'entity:update'>
        const held = useEntityStore.getState().byId[id]
        if (!held) throw new Error('unknown sheet')
        return { ...held, fields: { ...held.fields, ...fields } } as Output<C>
      }
      if (channel === 'changes:record') {
        const value = input as Input<'changes:record'>
        recorded.push(value)
        return value.changes.map((change, i) => ({
          id: `log-${recorded.length}-${i}`,
          runId: `${value.source}:${value.run}`,
          createdAt: '2026-10-09T10:00:00.000Z',
          nodeId: null,
          quote: null,
          kind: change.kind,
          entityId: null,
          label: change.label,
          status: 'applied',
          source: value.source,
          undoable: change.undo.type !== 'none'
        })) as Output<C>
      }
      if (channel === 'changes:undo') {
        logUndos.push((input as Input<'changes:undo'>).id)
        return {
          entries: [],
          removedEntityIds: [],
          removedTagIds: [],
          entityIds: [],
          nodeIds: [],
          entities: [],
          tags: []
        } as Output<C>
      }
      if (channel === 'record:addLine') {
        const line = input as Input<'record:addLine'>
        addedLines.push(line)
        return {
          record: storyRecord(),
          index: addedLines.length - 1,
          text: line.text,
          conflict: null
        } as Output<C>
      }
      if (channel === 'record:removeLine') {
        removedLines.push(input as Input<'record:removeLine'>)
        return storyRecord() as Output<C>
      }
      if (channel === 'editPass:changes') {
        const { nodeId } = input as Input<'editPass:changes'>
        return trackedRows.filter(
          (row) => row.nodeId === nodeId && row.status === 'pending'
        ) as Output<C>
      }
      if (channel === 'editPass:settle') {
        const asked = input as Input<'editPass:settle'>
        trackedSettles.push(asked)
        const moved = trackedRows
          .filter((row) => asked.ids.includes(row.id) && row.status === 'pending')
          .map((row) => ({ ...row, status: asked.status }))
        trackedRows = trackedRows.map((row) => moved.find((entry) => entry.id === row.id) ?? row)
        return moved as Output<C>
      }
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: true } as Output<C>
      }
      if (channel === 'ai:agentDraft') {
        const { requestId } = input as Input<'ai:agentDraft'>
        return {
          ok: true,
          text: DRAFTED,
          usage: { inputTokens: 400, outputTokens: 20 },
          costUsd: 0.0001,
          cached: false,
          model: 'gpt-fake',
          flagged: false,
          violation: null,
          proposalId: `draft-${requestId}`,
          requestId
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'ai:agentStep') {
        stepListener = listener as (payload: EventPayload<'ai:agentStep'>) => void
      }
      if (event === 'scribe:trackedSettled') {
        trackedListener = listener as (payload: EventPayload<'scribe:trackedSettled'>) => void
      }
      return () => {
        unsubscribed++
        if (event === 'ai:agentStep') stepListener = null
      }
    }
  }
}

/** F-16.26: the record a sheet line lands on, as `record:addLine` answers it. */
const storyRecord = (): Output<'record:removeLine'> => ({
  id: 'r-mara',
  categoryId: 'character',
  kind: 'character',
  name: 'Mara',
  image: null,
  origin: 'author',
  aliases: [],
  created: '2026-10-13T09:00:00.000Z',
  modified: '2026-10-13T09:00:00.000Z',
  pinned: null,
  ideas: null
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c-1',
  title: 'Why the ridge?',
  mode: 'plan',
  paragraphs: 1,
  messages: [
    {
      id: 'm-1',
      role: 'user',
      content: 'Why the ridge?',
      created: '2026-09-15T10:00:00.000Z',
      proposalId: null,
      model: null,
      costUsd: null,
      usage: null,
      mode: null,
      query: null,
      directions: null,
      action: null,
      agent: null,
      edit: null,
      card: null,
      scribe: null,
      costParts: null,
      contradictions: null,
      sources: null
    },
    {
      id: 'm-2',
      role: 'assistant',
      content: 'Because Mara wants the view.',
      created: '2026-09-15T10:00:01.000Z',
      proposalId: 'p-1',
      model: 'gpt-fake',
      costUsd: 0.0002,
      usage: { inputTokens: 300, outputTokens: 20 },
      mode: 'plan',
      query: null,
      directions: null,
      action: null,
      agent: null,
      edit: null,
      card: null,
      scribe: null,
      costParts: null,
      contradictions: null,
      sources: null
    }
  ],
  created: '2026-09-15T10:00:00.000Z',
  modified: '2026-09-15T10:00:01.000Z',
  ...over
})

const STORED: Conversations = { active: 'c-1', items: [conversation()] }

type AgentOk = Extract<AiAgentResult, { ok: true }>

/** A chat agent answer (F-5.22) with no lookups, citations, or edits. */
const ok = (requestId: string, answer: string, over: Partial<AgentOk> = {}): AiAgentResult => ({
  ok: true,
  answer,
  query: null,
  steps: [],
  changes: [],
  organise: null,
  scribe: null,
  dropped: 0,
  usage: { inputTokens: 200, outputTokens: 40 },
  costUsd: 0.0003,
  cached: false,
  model: 'gpt-fake',
  proposalId: `prop-${requestId}`,
  requestId,
  ...over
})

type ScribeOk = Extract<AiScribeResult, { ok: true }>

/** Ms Scribe's answer (notes redesign phase 1) with no lookups, changes, or sources. */
const scribeOk = (
  requestId: string,
  answer: string,
  over: Partial<ScribeOk> = {}
): AiScribeResult => ({
  ok: true,
  answer,
  steps: [],
  changes: [],
  sources: { scenes: [], pages: [] },
  usage: { inputTokens: 200, outputTokens: 40 },
  costUsd: 0.0003,
  cached: false,
  model: 'gpt-fake',
  proposalId: `prop-${requestId}`,
  requestId,
  ...over
})

/** Puts the project's AI on, in chat mode `chatMode` (2026-10-07). */
const inMode = (chatMode: 'vibe' | 'write' | 'brainstorm'): void => {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1, chatMode } })
}

const store = (): ReturnType<typeof useAssistantStore.getState> => useAssistantStore.getState()
const active = (): Conversation => {
  const value = store().conversations
  const found = value?.items.find((c) => c.id === value.active)
  if (!found) throw new Error('no active conversation')
  return found
}
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Sends `text` in the loaded state and hands back the request Ms Scribe received (a v1 project). */
async function sendAndCapture(text: string): Promise<PendingScribe> {
  const sending = store().send(text)
  await settle()
  const request = scribes[scribes.length - 1]
  if (!request) throw new Error('nothing was sent')
  return Object.assign(request, { done: sending })
}

beforeEach(() => {
  vi.useFakeTimers()
  sets = []
  queries = []
  scribes = []
  restoredVersions = []
  deletedPages = []
  whatNexts = []
  settles = []
  cancels = []
  routeAction = 'chat'
  stepListener = null
  unsubscribed = 0
  renames = []
  recorded = []
  logUndos = []
  addedLines = []
  removedLines = []
  trackedRows = []
  trackedSettles = []
  trackedListener = null
  resetEditPassStore()
  resetChangesStore()
  resetEntityStore()
  resetAssistantStore()
  resetAiSettingsStore()
  resetDocumentStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetProposalStore()
  resetPendingSaves()
  resetTagStore()
  resetLayoutStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(deferredClient(STORED))
})
afterEach(() => {
  resetEditPassStore()
  resetChangesStore()
  resetEntityStore()
  resetAssistantStore()
  resetAiSettingsStore()
  resetDocumentStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetLayoutStore()
  useTreeStore.getState().clear()
  vi.useRealTimers()
})

describe('useAssistantStore load and persistence (F-5.4)', () => {
  it('starts empty, loads the stored conversations, and subscribes to the agent steps', async () => {
    expect(store().conversations).toBeNull()
    expect(stepListener).toBeNull()
    await store().load()
    expect(store().conversations).toEqual(STORED)
    expect(stepListener).not.toBeNull()
    expect(sets).toHaveLength(0)
  })

  it('gives a fresh project one conversation to write in without writing it, and no per-conversation mode (2026-10-07)', async () => {
    setIpcClient(deferredClient({ active: null, items: [] }))
    await store().load()
    const value = store().conversations
    expect(value?.items).toHaveLength(1)
    expect(value?.active).toBe(value?.items[0]?.id)
    expect(value?.items[0]).toMatchObject({
      title: NEW_CONVERSATION_TITLE,
      paragraphs: 1,
      messages: []
    })
    expect(value?.items[0]?.mode).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('repairs a stored active id that names no conversation', async () => {
    setIpcClient(deferredClient({ active: 'gone', items: [conversation()] }))
    await store().load()
    expect(store().conversations?.active).toBe('c-1')
  })

  it('applies a change at once and writes it once after the debounce', async () => {
    await store().load()
    store().newConversation()
    store().select('c-1')
    expect(store().conversations?.items).toHaveLength(2)
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items).toHaveLength(2)
    expect(sets[0]?.value.active).toBe('c-1')
    sets[0]?.resolve()
    await settle()
    expect(store().conversations?.items).toHaveLength(2)
  })

  it('reverts to the value before a failed write and toasts', async () => {
    await store().load()
    store().newConversation()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    sets[0]?.reject(new Error('disk full'))
    await settle()
    expect(store().conversations).toEqual(STORED)
    expect(toasts()).toEqual(['disk full'])
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().newConversation()
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items).toHaveLength(2)
    sets[0]?.resolve()
    await flushing
  })

  it('clear empties the store, cancels the pending write, and drops the step subscription', async () => {
    await store().load()
    store().newConversation()
    store().clear()
    expect(store().conversations).toBeNull()
    // The lookup steps, (2026-10-07) the streamed answer and (2026-10-15) the tracked settles.
    expect(unsubscribed).toBe(3)
    expect(stepListener).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('ignores changes before anything is loaded', async () => {
    store().newConversation()
    await store().send('hello')
    expect(store().conversations).toBeNull()
    expect(queries).toHaveLength(0)
  })
})

describe('useAssistantStore tabs (F-5.4)', () => {
  it('newConversation opens a fresh tab as the active one, up to the cap', async () => {
    await store().load()
    store().newConversation()
    const value = store().conversations
    expect(value?.items).toHaveLength(2)
    expect(value?.active).toBe(value?.items[1]?.id)
    expect(active()).toMatchObject({ title: NEW_CONVERSATION_TITLE, messages: [] })
    for (let i = 0; i < CHAT_MAX_CONVERSATIONS + 2; i++) store().newConversation()
    expect(store().conversations?.items).toHaveLength(CHAT_MAX_CONVERSATIONS)
  })

  it('select switches the active tab and ignores an unknown or already active id', async () => {
    await store().load()
    store().newConversation()
    const second = store().conversations?.active ?? ''
    store().select('c-1')
    expect(store().conversations?.active).toBe('c-1')
    store().select('nope')
    expect(store().conversations?.active).toBe('c-1')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    store().select(second)
    expect(store().conversations?.active).toBe(second)
  })

  it('renameConversation retitles a tab (trimmed, cut to the cap) and writes it; blank, unchanged, or unknown is a no-op', async () => {
    await store().load()
    store().renameConversation('c-1', '   ')
    store().renameConversation('c-1', 'Why the ridge?')
    store().renameConversation('nope', 'Other')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
    store().renameConversation('c-1', `  ${'x'.repeat(CHAT_TITLE_MAX + 5)}  `)
    expect(active().title).toBe('x'.repeat(CHAT_TITLE_MAX))
    store().renameConversation('c-1', ' Ridge research ')
    expect(active().title).toBe('Ridge research')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items[0]?.title).toBe('Ridge research')
  })

  it('closeConversation drops a tab, moves the selection to a neighbour, and replaces the last tab with a fresh one', async () => {
    await store().load()
    store().newConversation()
    const second = store().conversations?.active ?? ''
    store().closeConversation(second)
    expect(store().conversations?.items.map((c) => c.id)).toEqual(['c-1'])
    expect(store().conversations?.active).toBe('c-1')
    store().closeConversation('c-1')
    const value = store().conversations
    expect(value?.items).toHaveLength(1)
    expect(value?.items[0]?.id).not.toBe('c-1')
    expect(value?.active).toBe(value?.items[0]?.id)
    expect(active().messages).toEqual([])
  })
})

describe('useAssistantStore send (F-5.4; the router, then Ms Scribe in v1 since the notes redesign)', () => {
  it('appends the turn and an empty answer, asks Ms Scribe in Write with the recent history, then fills the answer with its cost', async () => {
    await store().load()
    const request = await sendAndCapture('  What does Mara want?  ')
    expect(request.input).toEqual({
      nodeId: null,
      message: 'What does Mara want?',
      history: [
        { role: 'user', content: 'Why the ridge?' },
        { role: 'assistant', content: 'Because Mara wants the view.' }
      ],
      mode: 'write',
      focus: { beforeCaret: '', selection: '' },
      wholeBook: false,
      requestId: expect.any(String) as string
    })
    expect(active().messages).toHaveLength(4)
    expect(active().messages[2]).toMatchObject({ role: 'user', content: 'What does Mara want?' })
    expect(active().messages[3]).toMatchObject({
      role: 'assistant',
      content: '',
      mode: 'plan',
      action: 'chat'
    })
    expect(store().pending['c-1']).toBe(request.input.requestId)

    request.resolve(scribeOk(request.input.requestId, 'The view.', { cached: true }))
    await settle()
    expect(store().pending).toEqual({})
    const answer = active().messages[3]
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'The view.',
      model: 'gpt-fake',
      costUsd: 0.0003,
      usage: { inputTokens: 200, outputTokens: 40 },
      proposalId: `prop-${request.input.requestId}`,
      mode: 'plan',
      agent: { access: 'write', steps: [], changes: [] }
    })
    expect(store().cached[answer?.id ?? '']).toBe(true)
    expect(settles).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items[0]?.messages).toHaveLength(4)
  })

  it('titles a fresh conversation after its first message and sends at most the last ten non-empty turns', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}`,
      created: '2026-09-15T10:00:00.000Z',
      proposalId: null,
      model: null,
      costUsd: null,
      usage: null,
      mode: null,
      query: null,
      directions: null,
      action: null,
      agent: null,
      edit: null,
      card: null,
      scribe: null,
      costParts: null,
      contradictions: null,
      sources: null
    }))
    setIpcClient(
      deferredClient({
        active: 'c-1',
        items: [conversation({ title: NEW_CONVERSATION_TITLE, messages: many })]
      })
    )
    await store().load()
    const request = await sendAndCapture('again')
    expect(request.input.history).toHaveLength(CHAT_HISTORY_TURNS)
    expect(request.input.history[0]?.content).toBe('turn 4')
    expect(active().title).toBe(NEW_CONVERSATION_TITLE)

    setIpcClient(
      deferredClient({
        active: 'c-1',
        items: [conversation({ title: NEW_CONVERSATION_TITLE, messages: [] })]
      })
    )
    resetAssistantStore()
    scribes = []
    await store().load()
    const long = 'A question that runs well past the forty-character title cap'
    const first = await sendAndCapture(long)
    expect(first.input.history).toEqual([])
    expect(active().title).toBe(titleFor(long))
    expect(active().title.endsWith('…')).toBe(true)
  })

  it('keeps a title the author gave a fresh conversation when its first message is sent (2026-10-07)', async () => {
    setIpcClient(
      deferredClient({
        active: 'c-1',
        items: [conversation({ title: NEW_CONVERSATION_TITLE, messages: [] })]
      })
    )
    await store().load()
    store().renameConversation('c-1', 'Ridge research')
    await sendAndCapture('Why the ridge?')
    expect(active().title).toBe('Ridge research')
  })

  it('ignores a blank message and a second send while one is in flight', async () => {
    await store().load()
    await store().send('   ')
    expect(scribes).toHaveLength(0)
    const sending = store().send('one')
    await settle()
    await store().send('two')
    expect(scribes).toHaveLength(1)
    expect(active().messages).toHaveLength(4)
    scribes[0]?.resolve(scribeOk(scribes[0].input.requestId, 'answer'))
    await sending
  })

  it('an expected failure removes the empty answer and toasts the cause with the next step', async () => {
    await store().load()
    const request = await sendAndCapture('hello')
    request.resolve({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add one in Settings.',
      requestId: request.input.requestId
    })
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(active().messages[2]?.role).toBe('user')
    expect(store().pending).toEqual({})
    expect(toasts()).toEqual(['No API key is saved. Add one in Settings.'])
  })

  it('a rejected request toasts its message and clears the pending turn', async () => {
    await store().load()
    const request = await sendAndCapture('hello')
    request.reject(new Error('bridge down'))
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(toasts()).toEqual(['bridge down'])
    expect(store().pending).toEqual({})
  })

  it('drops the answer of a conversation closed meanwhile and rejects its proposal', async () => {
    await store().load()
    store().newConversation()
    const second = store().conversations?.active ?? ''
    const sending = store().send('hello')
    await settle()
    store().closeConversation(second)
    const request = scribes[0]
    request?.resolve(scribeOk(request.input.requestId, 'late'))
    await sending
    expect(store().conversations?.items.map((c) => c.id)).toEqual(['c-1'])
    expect(settles).toEqual([
      { id: `prop-${request?.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(toasts()).toEqual([])
  })
})

describe('useAssistantStore stop (F-5.10)', () => {
  const cancelled = (requestId: string): AiScribeResult => ({
    ok: false,
    code: 'CANCELLED',
    message: 'The request was stopped.',
    nextStep: 'Send it again whenever you like.',
    requestId
  })

  it('tracks the request in the activity store until its reply lands', async () => {
    await store().load()
    const request = await sendAndCapture('hello')
    expect(useAiActivityStore.getState().inflight).toEqual({
      [request.input.requestId]: { feature: 'scribe', startedAt: expect.any(Number) as number }
    })
    request.resolve(scribeOk(request.input.requestId, 'answer'))
    await settle()
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('stop drops the unanswered turn, keeps the author’s turn, asks main to stop, and the reply is silent', async () => {
    await store().load()
    const request = await sendAndCapture('What next?')
    expect(active().messages).toHaveLength(4)
    store().stop()
    expect(active().messages).toHaveLength(3)
    expect(active().messages[2]).toMatchObject({ role: 'user', content: 'What next?' })
    expect(store().pending).toEqual({})
    expect(cancels).toEqual([request.input.requestId])
    expect(toasts()).toEqual([])
    request.resolve(cancelled(request.input.requestId))
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(toasts()).toEqual([])
    expect(settles).toEqual([])
    // The author can send again at once.
    const again = await sendAndCapture('What next?')
    expect(again.input.requestId).not.toBe(request.input.requestId)
    expect(active().messages).toHaveLength(5)
    again.resolve(scribeOk(again.input.requestId, 'She climbs.'))
    await settle()
    expect(active().messages[4]?.content).toBe('She climbs.')
  })

  it('stop is a no-op without a request in flight, and a late answer for a stopped request only rejects its proposal', async () => {
    await store().load()
    store().stop()
    expect(cancels).toEqual([])
    const request = await sendAndCapture('hello')
    store().stop()
    request.resolve(scribeOk(request.input.requestId, 'late'))
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(settles).toEqual([
      { id: `prop-${request.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(toasts()).toEqual([])
  })

  it('a cancelled reply that lands while the turn is still pending drops it without a toast', async () => {
    await store().load()
    const request = await sendAndCapture('hello')
    request.resolve(cancelled(request.input.requestId))
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(store().pending).toEqual({})
    expect(toasts()).toEqual([])
  })

  it('closing a conversation stops its request in flight', async () => {
    await store().load()
    store().newConversation()
    const second = store().conversations?.active ?? ''
    const sending = store().send('hello')
    await settle()
    store().closeConversation(second)
    expect(cancels).toEqual([scribes[0]?.input.requestId])
    scribes[0]?.resolve(cancelled(scribes[0].input.requestId))
    await sending
    expect(toasts()).toEqual([])
  })
})

describe('useAssistantStore chat modes (Brainstorm, Write, Vibe since 2026-10-15)', () => {
  it('sends Ms Scribe the mode, and the turn records read access in Brainstorm only', async () => {
    await store().load()
    for (const [mode, access] of [
      ['write', 'write'],
      ['vibe', 'write'],
      ['brainstorm', 'read']
    ] as const) {
      inMode(mode)
      const request = await sendAndCapture(`In ${mode}?`)
      expect(request.input.mode).toBe(mode)
      expect(active().messages.at(-1)).toMatchObject({ mode: 'plan', action: 'chat' })
      request.resolve(scribeOk(request.input.requestId, 'Yes.'))
      await settle()
      expect(active().messages.at(-1)?.agent?.access).toBe(access)
    }
  })

  it('in Brainstorm a router pick that would edit runs as the chat instead', async () => {
    inMode('brainstorm')
    await store().load()
    for (const pick of ['rewrite', 'proofread', 'critique', 'continuity', 'synopsis'] as const) {
      routeAction = pick
      const request = await sendAndCapture(`Do ${pick}`)
      expect(request.input.mode).toBe('brainstorm')
      expect(active().messages.at(-1)).toMatchObject({ action: 'chat', mode: 'plan' })
      request.resolve(scribeOk(request.input.requestId, 'Here is what I think.'))
      await settle()
    }
    expect(scribes).toHaveLength(5)
    expect(toasts()).toEqual([])
  })

  it('reads the mode when a message is sent, for every conversation tab alike', async () => {
    inMode('brainstorm')
    await store().load()
    store().newConversation()
    const first = await sendAndCapture('One')
    expect(first.input.mode).toBe('brainstorm')
    first.resolve(scribeOk(first.input.requestId, 'A.'))
    await settle()
    store().select('c-1')
    inMode('write')
    const second = await sendAndCapture('Two')
    expect(second.input.mode).toBe('write')
  })

  it('sends Whole book while it is on', async () => {
    inMode('write')
    await store().load()
    store().setWholeBook(true)
    const request = await sendAndCapture('Is the book consistent?')
    expect(request.input.wholeBook).toBe(true)
  })
})

describe('useAssistantStore Ms Scribe changes (notes redesign phase 1)', () => {
  const NOTE_EDIT = {
    kind: 'notebook',
    pageId: 'pg-mara',
    title: 'Mara',
    created: false,
    versionId: 'v-1',
    section: null,
    before: 'Eyes: grey',
    after: 'Eyes: grey\nFears the sea'
  } as const
  const NOTE_CREATED = {
    ...NOTE_EDIT,
    pageId: 'pg-new',
    title: 'Powers',
    created: true,
    versionId: null
  }
  const PROSE = {
    kind: 'text',
    nodeId: 'sc-1',
    title: 'Scene 1',
    find: 'Mara climbed the ridge alone.',
    replace: 'Mara climbed the ridge with her fear.',
    brief: ''
  } as const

  it('lands note edits applied with sources, keeps prose waiting even in Vibe, and Undo restores the note', async () => {
    inMode('vibe')
    await store().load()
    const request = await sendAndCapture('Put that she fears the sea in Mara’s page.')
    request.resolve(
      scribeOk(request.input.requestId, 'Added it to Mara.', {
        changes: [
          { edit: NOTE_EDIT, violation: null, applied: true, trackedId: null },
          { edit: NOTE_CREATED, violation: null, applied: true, trackedId: null },
          { edit: PROSE, violation: null, applied: false, trackedId: null }
        ],
        sources: {
          scenes: [{ nodeId: 'sc-1', title: 'Scene 1', quotes: [] }],
          pages: [{ id: 'pg-mara', title: 'Mara', kind: 'note', quotes: [] }]
        }
      })
    )
    await settle()
    const turn = active().messages.at(-1)
    expect(turn?.sources?.pages).toEqual([
      { id: 'pg-mara', title: 'Mara', kind: 'note', quotes: [] }
    ])
    expect(turn?.agent?.changes.map((c) => c.status)).toEqual(['applied', 'applied', 'pending'])
    expect(settles).toEqual([])
    const [edited, created] = turn?.agent?.changes ?? []
    await store().undoChange(turn?.id ?? '', edited?.id ?? '')
    await store().undoChange(turn?.id ?? '', created?.id ?? '')
    expect(restoredVersions).toEqual(['v-1'])
    expect(deletedPages).toEqual(['pg-new'])
    expect(
      active()
        .messages.at(-1)
        ?.agent?.changes.map((c) => c.status)
    ).toEqual(['undone', 'undone', 'pending'])
  })

  it('settles the proposal at once when every change is a note edit', async () => {
    inMode('write')
    await store().load()
    const request = await sendAndCapture('Save that.')
    request.resolve(
      scribeOk(request.input.requestId, 'Saved.', {
        changes: [{ edit: NOTE_EDIT, violation: null, applied: true, trackedId: null }]
      })
    )
    await settle()
    expect(settles).toEqual([
      { id: `prop-${request.input.requestId}`, status: 'accepted', note: null }
    ])
  })
})

describe('useAssistantStore Ms Scribe prose suggestions as tracked changes (notes fixes, 2026-10-15)', () => {
  const PROSE = {
    kind: 'text',
    nodeId: 'sc-1',
    title: 'Scene 1',
    find: 'Mara climbed the ridge alone.',
    replace: 'Mara climbed the ridge with her fear.',
    brief: ''
  } as const
  const row = (over: Partial<EditChange> = {}): EditChange => ({
    id: 'tc-1',
    passId: 'scribe-pass',
    nodeId: 'sc-1',
    kind: 'change',
    position: 0,
    original: PROSE.find,
    replacement: PROSE.replace,
    rationale: 'Ms Scribe’s suggestion',
    category: null,
    flagged: false,
    violation: null,
    status: 'pending',
    proposalId: 'prop-x',
    ...over
  })

  /** A Vibe turn whose one prose suggestion waits as tracked change `tc-1`; answers the card. */
  async function suggest(): Promise<{ messageId: string; changeId: string; proposalId: string }> {
    inMode('vibe')
    await store().load()
    const request = await sendAndCapture('Make this scene better.')
    request.resolve(
      scribeOk(request.input.requestId, 'One change: the ridge line.', {
        changes: [{ edit: PROSE, violation: null, applied: false, trackedId: 'tc-1' }]
      })
    )
    await settle()
    const turn = active().messages.at(-1)
    const change = turn?.agent?.changes[0]
    expect(change).toMatchObject({ status: 'pending', trackedId: 'tc-1' })
    return {
      messageId: turn?.id ?? '',
      changeId: change?.id ?? '',
      proposalId: `prop-${request.input.requestId}`
    }
  }

  function mountScene(text: string): Editor {
    const editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    })
    registerTrackedEditor('sc-1', editor)
    return editor
  }

  it('marks the card from a settle in the text: accepted as applied, and the turn settles', async () => {
    const { proposalId } = await suggest()
    expect(trackedListener).not.toBeNull()
    trackedListener?.({ changes: [row({ status: 'accepted' })] })
    await settle()
    expect(active().messages.at(-1)?.agent?.changes[0]?.status).toBe('applied')
    expect(settles).toEqual([{ id: proposalId, status: 'accepted', note: null }])
  })

  it('marks a rejection in the text as rejected, and a passage edited since as text changed', async () => {
    const first = await suggest()
    trackedListener?.({ changes: [row({ status: 'rejected' })] })
    await settle()
    expect(findCard(first.messageId)).toMatchObject({ status: 'skipped' })
    expect(settles).toEqual([{ id: first.proposalId, status: 'rejected', note: null }])

    const request = await sendAndCapture('And again.')
    request.resolve(
      scribeOk(request.input.requestId, 'Another.', {
        changes: [{ edit: PROSE, violation: null, applied: false, trackedId: 'tc-2' }]
      })
    )
    await settle()
    const second = active().messages.at(-1)?.id ?? ''
    trackedListener?.({ changes: [row({ id: 'tc-2', status: 'stale' })] })
    await settle()
    expect(findCard(second)).toMatchObject({ status: 'failed', error: TRACKED_TEXT_CHANGED })
    // A settle for a card already decided changes nothing.
    trackedListener?.({ changes: [row({ status: 'accepted' })] })
    expect(findCard(first.messageId)).toMatchObject({ status: 'skipped' })
  })

  it('Apply on the card accepts the tracked change in the scene and settles it there', async () => {
    const editor = mountScene(PROSE.find)
    const { messageId, changeId, proposalId } = await suggest()
    trackedRows = [row()]
    await store().applyChange(messageId, changeId)
    await settle()
    expect(editor.getText()).toBe(PROSE.replace)
    expect(trackedSettles).toEqual([{ ids: ['tc-1'], status: 'accepted' }])
    expect(findCard(messageId)).toMatchObject({ status: 'applied' })
    expect(settles).toEqual([{ id: proposalId, status: 'accepted', note: null }])
    editor.destroy()
  })

  it('Apply on a card whose passage changed since marks it text changed, and nothing lands', async () => {
    const editor = mountScene('Mara stayed home.')
    const { messageId, changeId } = await suggest()
    trackedRows = [row()]
    await store().applyChange(messageId, changeId)
    await settle()
    expect(editor.getText()).toBe('Mara stayed home.')
    expect(trackedSettles).toEqual([{ ids: ['tc-1'], status: 'stale' }])
    expect(findCard(messageId)).toMatchObject({ status: 'failed', error: TRACKED_TEXT_CHANGED })
    editor.destroy()
  })

  it('Skip on the card rejects the tracked change in the scene', async () => {
    const { messageId, changeId } = await suggest()
    trackedRows = [row()]
    store().skipChange(messageId, changeId)
    await settle()
    expect(findCard(messageId)).toMatchObject({ status: 'skipped' })
    expect(trackedSettles).toEqual([{ ids: ['tc-1'], status: 'rejected' }])
  })

  function findCard(messageId: string): AgentChangeView | undefined {
    return active().messages.find((m) => m.id === messageId)?.agent?.changes[0]
  }
})

type AgentChangeView = NonNullable<Conversation['messages'][number]['agent']>['changes'][number]

describe("useAssistantStore send, a question about the book (the router's query pick, Ms Scribe in v1)", () => {
  beforeEach(() => {
    routeAction = 'query'
  })

  const SOURCES = {
    scenes: [{ nodeId: 'sc-1', title: 'Chapter 1 › Scene 1', quotes: [] }],
    pages: [{ id: 'pg-storm', title: 'Storms', kind: 'note' as const, quotes: [] }]
  }
  const lookupOk = (requestId: string, over: Partial<ScribeOk> = {}): AiScribeResult =>
    scribeOk(requestId, 'She waits for the storm in Chapter 1 › Scene 1.', {
      steps: [{ tool: 'search_book', label: 'Searching “storm”…' }],
      sources: SOURCES,
      usage: { inputTokens: 900, outputTokens: 60 },
      costUsd: 0.0009,
      ...over
    })

  it('asks Ms Scribe with the open scene and the recent history, shows her lookups live, and fills the turn with the answer, its cost, and its sources', async () => {
    await store().load()
    const request = await sendAndCapture('  Where does the storm break?  ')
    expect(request.input).toEqual({
      nodeId: null,
      message: 'Where does the storm break?',
      history: [
        { role: 'user', content: 'Why the ridge?' },
        { role: 'assistant', content: 'Because Mara wants the view.' }
      ],
      mode: 'write',
      focus: { beforeCaret: '', selection: '' },
      wholeBook: false,
      requestId: expect.any(String) as string
    })
    expect(useAiActivityStore.getState().inflight).toEqual({
      [request.input.requestId]: { feature: 'scribe', startedAt: expect.any(Number) as number }
    })
    expect(active().messages[3]).toMatchObject({ role: 'assistant', content: '', mode: 'query' })
    const step = { tool: 'search_book', label: 'Searching “storm”…' } as const
    stepListener?.({ requestId: request.input.requestId, step })
    stepListener?.({ requestId: 'someone-else', step })
    expect(store().agentSteps).toEqual({ [request.input.requestId]: [step] })

    request.resolve(lookupOk(request.input.requestId, { cached: true }))
    await settle()
    expect(useAiActivityStore.getState().inflight).toEqual({})
    expect(store().pending).toEqual({})
    const answer = active().messages[3]
    expect(answer).toMatchObject({
      role: 'assistant',
      mode: 'query',
      content: 'She waits for the storm in Chapter 1 › Scene 1.',
      model: 'gpt-fake',
      costUsd: 0.0009,
      usage: { inputTokens: 900, outputTokens: 60 },
      proposalId: `prop-${request.input.requestId}`,
      sources: SOURCES,
      agent: { access: 'write', steps: [step], changes: [] }
    })
    expect(store().agentSteps).toEqual({})
    expect(store().cached[answer?.id ?? '']).toBe(true)
    expect(settles).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets[0]?.value.items[0]?.messages[3]).toMatchObject({ sources: SOURCES })
  })

  it('sends the active scene and its selection', async () => {
    const editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The boat rocked.' }] }]
      }
    })
    editor.commands.setTextSelection({ from: 5, to: 9 })
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    const request = await sendAndCapture('Who owns the boat?')
    expect(request.input.nodeId).toBe('sc-1')
    expect(request.input.focus).toEqual({ beforeCaret: 'The ', selection: 'boat' })
    request.resolve(lookupOk(request.input.requestId))
    await settle()
    editor.destroy()
  })

  it('an expected failure drops the unanswered turn and toasts, and a stop is silent', async () => {
    await store().load()
    const request = await sendAndCapture('Where is Mara?')
    request.resolve({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add one in Settings.',
      requestId: request.input.requestId
    })
    await settle()
    expect(active().messages).toHaveLength(3)
    expect(store().pending).toEqual({})
    expect(toasts()).toEqual(['No API key is saved. Add one in Settings.'])

    const again = await sendAndCapture('Where is Mara?')
    store().stop()
    expect(cancels).toEqual([again.input.requestId])
    again.resolve({
      ok: false,
      code: 'CANCELLED',
      message: 'The request was stopped.',
      nextStep: 'Send it again whenever you like.',
      requestId: again.input.requestId
    })
    await settle()
    // The author's two turns stay: both can be sent again.
    expect(active().messages).toHaveLength(4)
    expect(active().messages.at(-1)).toMatchObject({ role: 'user', content: 'Where is Mara?' })
    expect(toasts()).toEqual(['No API key is saved. Add one in Settings.'])
  })

  it('rejects the proposal of an answer whose conversation closed meanwhile', async () => {
    await store().load()
    store().newConversation()
    const second = store().conversations?.active ?? ''
    const asking = store().send('Where is Mara?')
    await settle()
    store().closeConversation(second)
    const request = scribes[0]
    request?.resolve(lookupOk(request.input.requestId))
    await asking
    expect(settles).toEqual([
      { id: `prop-${request?.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(toasts()).toEqual([])
  })
})

describe('useAssistantStore agent edits (F-5.22)', () => {
  const RENAME = {
    kind: 'rename',
    nodeId: 'sc-1',
    title: 'Scene 1',
    after: 'The ridge'
  } as const
  const DELETE = { kind: 'delete', target: 'node', id: 'sc-2', name: 'Scene 2' } as const

  const agentOk = (requestId: string): AiAgentResult => ({
    ok: true,
    answer: 'Renamed it.',
    query: null,
    steps: [],
    changes: [
      { edit: RENAME, violation: null },
      { edit: DELETE, violation: null }
    ],
    organise: null,
    scribe: null,
    dropped: 0,
    usage: { inputTokens: 900, outputTokens: 60 },
    costUsd: 0.0009,
    cached: false,
    model: 'gpt-fake',
    proposalId: `prop-${requestId}`,
    requestId
  })

  /** A turn the router sends to chat, so the agent runs with write access and answers with edits. */
  async function answerWithEdits(auto: boolean): Promise<string> {
    useTreeStore.setState(buildIndex(treeFixture))
    inMode(auto ? 'vibe' : 'write')
    await store().load()
    const asking = store().send('Rename the first scene.', { agent: 'write' })
    await settle()
    const request = queries[0]
    if (!request) throw new Error('nothing was asked')
    expect(request.input.access).toBe('write')
    request.resolve(agentOk(request.input.requestId))
    await asking
    await settle()
    return active().messages.at(-1)?.id ?? ''
  }

  const changes = (): { status: string; error: string | null }[] =>
    (active().messages.at(-1)?.agent?.changes ?? []).map(({ status, error }) => ({ status, error }))

  it('in Ask every edit waits; Apply runs it through the tree store, Skip leaves the book alone, and the proposal settles once none waits', async () => {
    const messageId = await answerWithEdits(false)
    expect(changes()).toEqual([
      { status: 'pending', error: null },
      { status: 'pending', error: null }
    ])
    expect(renames).toEqual([])
    const [rename, remove] = active().messages.at(-1)?.agent?.changes ?? []
    await store().applyChange(messageId, rename?.id ?? '')
    expect(renames).toEqual([{ id: 'sc-1', title: 'The ridge' }])
    expect(useTreeStore.getState().byId['sc-1']?.title).toBe('The ridge')
    expect(settles).toEqual([])
    store().skipChange(messageId, remove?.id ?? '')
    expect(changes().map((c) => c.status)).toEqual(['applied', 'skipped'])
    const proposalId = active().messages.at(-1)?.proposalId
    expect(settles).toEqual([{ id: proposalId, status: 'acceptedPart', note: null }])

    await store().undoChange(messageId, rename?.id ?? '')
    expect(renames.at(-1)).toEqual({ id: 'sc-1', title: 'Scene 1' })
    expect(changes().map((c) => c.status)).toEqual(['undone', 'skipped'])
  })

  it('logs a sheet edit in Changes under the turn, and its Undo is the log’s (F-9.15)', async () => {
    const mara = entityFixture.find((entity) => entity.id === 'e-mara')
    if (!mara) throw new Error('fixture lost Mara')
    useEntityStore.getState().merge(mara)
    useTreeStore.setState(buildIndex(treeFixture))
    inMode('vibe')
    await store().load()
    const asking = store().send('Make Mara 28.', { agent: 'write' })
    await settle()
    const request = queries[0]
    if (!request) throw new Error('nothing was asked')
    const base = agentOk(request.input.requestId)
    if (!base.ok) throw new Error('agentOk failed')
    request.resolve({
      ...base,
      changes: [
        {
          edit: {
            kind: 'sheet',
            entityId: 'e-mara',
            name: 'Mara',
            field: 'age',
            label: 'Age',
            before: '27',
            after: '28'
          },
          violation: null
        }
      ]
    })
    await asking
    await settle()
    const messageId = active().messages.at(-1)?.id ?? ''
    expect(changes().map((c) => c.status)).toEqual(['applied'])
    expect(useEntityStore.getState().byId['e-mara']?.fields.age).toBe('28')
    expect(recorded).toMatchObject([
      {
        source: 'chat',
        run: messageId,
        changes: [
          {
            kind: 'sheetEdit',
            undo: {
              type: 'restoreSheet',
              entityId: 'e-mara',
              before: { fields: { age: '27' } },
              after: { fields: { age: '28' } }
            }
          }
        ]
      }
    ])
    const change = active().messages.at(-1)?.agent?.changes[0]
    await store().undoChange(messageId, change?.id ?? '')
    expect(logUndos).toEqual(['log-1-0'])
    expect(changes().map((c) => c.status)).toEqual(['undone'])
  })

  it('in Auto applies every edit but a deletion at once, and the deletion still asks', async () => {
    await answerWithEdits(true)
    expect(renames).toEqual([{ id: 'sc-1', title: 'The ridge' }])
    expect(changes().map((c) => c.status)).toEqual(['applied', 'pending'])
    expect(settles).toEqual([])
  })

  it('undoes the last turn when asked (it asks, as a deletion) and opens the Library at once in Ask (F-5.25, agent.v8)', async () => {
    const firstId = await answerWithEdits(true)
    expect(renames).toEqual([{ id: 'sc-1', title: 'The ridge' }])
    inMode('write')
    const asking = store().send('Undo that, and open the Library.', { agent: 'write' })
    await settle()
    const request = queries[1]
    if (!request) throw new Error('nothing was asked')
    const base = agentOk(request.input.requestId)
    if (!base.ok) throw new Error('agentOk failed')
    request.resolve({
      ...base,
      changes: [
        { edit: { kind: 'undoTurn' }, violation: null },
        { edit: { kind: 'open', dialog: 'library' }, violation: null }
      ]
    })
    await asking
    await settle()
    const messageId = active().messages.at(-1)?.id ?? ''
    expect(changes().map((c) => c.status)).toEqual(['pending', 'applied'])
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('library')
    const undoTurn = active().messages.at(-1)?.agent?.changes[0]
    await store().applyChange(messageId, undoTurn?.id ?? '')
    expect(renames.at(-1)).toEqual({ id: 'sc-1', title: 'Scene 1' })
    const first = active().messages.find((m) => m.id === firstId)
    expect(first?.agent?.changes.map((c) => c.status)).toEqual(['undone', 'pending'])
    expect(changes().map((c) => c.status)).toEqual(['applied', 'applied'])
    // An applied undo never runs twice.
    await store().applyChange(messageId, undoTurn?.id ?? '')
    expect(changes()[0]?.status).toBe('applied')
  })

  describe('insertions as ghost text (2026-10-07)', () => {
    const INSERT = {
      kind: 'insert',
      nodeId: 'sc-1',
      title: 'Chapter 1 › Scene 1',
      after: 'Mara climbed the ridge alone.',
      text: '',
      brief: 'Rain follows her.',
      words: 40
    } as const
    let editor: Editor

    beforeEach(() => {
      editor = new Editor({
        extensions: buildExtensions({
          sceneBreak: '~~~',
          onSave: () => {},
          inlineTagNodeId: 'sc-1'
        }),
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Mara climbed the ridge alone.' }]
            }
          ]
        }
      })
      useActiveEditorStore.getState().set('sc-1', editor)
    })
    afterEach(() => {
      editor.destroy()
    })

    async function answerWithInsert(auto: boolean): Promise<string> {
      useTreeStore.setState(buildIndex(treeFixture))
      inMode(auto ? 'vibe' : 'write')
      await store().load()
      const asking = store().send('Add the rain.', { agent: 'write' })
      await settle()
      const request = queries[0]
      if (!request) throw new Error('nothing was asked')
      request.resolve(
        ok(request.input.requestId, 'Adding the rain.', {
          changes: [{ edit: INSERT, violation: null }]
        })
      )
      await asking
      for (let i = 0; i < 5; i++) await settle()
      return active().messages.at(-1)?.id ?? ''
    }

    const text = (): string => editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')

    it('in Auto the draft lands after its anchor and is accepted, logged with Undo', async () => {
      const messageId = await answerWithInsert(true)
      expect(text()).toBe(`Mara climbed the ridge alone.\n${DRAFTED}`)
      const change = active().messages.at(-1)?.agent?.changes[0]
      expect(change).toMatchObject({ status: 'applied', edit: { text: DRAFTED } })
      expect(change?.proposalId).toMatch(/^draft-/)
      expect(settles).toContainEqual({ id: change?.proposalId, status: 'accepted', note: null })
      await store().undoChange(messageId, change?.id ?? '')
      expect(text()).toBe('Mara climbed the ridge alone.')
    })

    it('in Ask the draft waits in the editor; the card mirrors it and its Dismiss skips it', async () => {
      const messageId = await answerWithInsert(false)
      const change = active().messages.at(-1)?.agent?.changes[0]
      expect(change?.status).toBe('shown')
      expect(ghostOf(editor.state)?.text).toBe(`\n\n${DRAFTED}`)
      expect(text()).toBe('Mara climbed the ridge alone.')
      store().skipChange(messageId, change?.id ?? '')
      for (let i = 0; i < 3; i++) await settle()
      expect(active().messages.at(-1)?.agent?.changes[0]?.status).toBe('skipped')
      expect(ghostOf(editor.state)).toBeNull()
    })
  })
})

describe('useAssistantStore openScene (F-5.7)', () => {
  const QUOTE = 'She turned from the window.'
  const TEXT = `The storm broke at dusk. ${QUOTE} Rain followed.`
  let editor: Editor
  /** A second scene's editor, registered to prove `openScene` waits for the right one. */
  let other: Editor

  const newEditor = (): Editor =>
    new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }]
      }
    })

  beforeEach(() => {
    useTreeStore.setState(buildIndex(treeFixture))
    editor = newEditor()
    other = newEditor()
  })
  afterEach(() => {
    editor.destroy()
    other.destroy()
  })

  const selectedText = (): string => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to)
  }

  it('selects the scene in the tree and the cited passage in its editor', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().openScene({ nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' }, QUOTE)
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(editor.state.selection).toMatchObject(locateText(editor.state.doc, QUOTE) ?? {})
    expect(selectedText()).toBe(QUOTE)
    expect(toasts()).toEqual([])
  })

  it('waits for the scene it opened to mount its editor, and gives up after the timeout', async () => {
    const opening = store().openScene({ nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' }, QUOTE)
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(selectedText()).toBe('')
    // A different scene's editor is not the one it waits for.
    useActiveEditorStore.getState().set('sc-2', other)
    await settle()
    expect(selectedText()).toBe('')
    useActiveEditorStore.getState().set('sc-1', editor)
    await opening
    expect(selectedText()).toBe(QUOTE)

    const never = store().openScene({ nodeId: 'sc-3', title: 'Chapter 3 › Scene 3' }, QUOTE)
    await vi.advanceTimersByTimeAsync(OPEN_SCENE_TIMEOUT_MS)
    await never
    expect(useTreeStore.getState().selectedId).toBe('sc-3')
    expect(toasts()).toEqual([])
  })

  it('toasts when the passage is no longer in the scene, and a chip without a quote only opens it', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().openScene(
      { nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' },
      'The lighthouse blinked twice.'
    )
    expect(toasts()).toEqual([PASSAGE_GONE_MESSAGE])
    expect(selectedText()).toBe('')

    useTreeStore.getState().select('sc-2')
    await store().openScene({ nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' }, null)
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(selectedText()).toBe('')
    expect(toasts()).toEqual([PASSAGE_GONE_MESSAGE])
  })
})

describe('useAssistantStore quick actions (F-5.17)', () => {
  const SCENE = 'Mara climbed the ridge at dusk. The storm had not broken yet.'
  const DIRECTIONS = [
    { title: 'The storm breaks', text: 'Rain drives them into the shepherd hut.' },
    { title: 'A light below', text: 'Someone is camped in the valley.' }
  ]
  let editor: Editor

  type WhatNextOk = Extract<AiWhatNextResult, { ok: true }>
  const whatNextOk = (requestId: string, over: Partial<WhatNextOk> = {}): AiWhatNextResult => ({
    ok: true,
    directions: DIRECTIONS,
    dropped: 0,
    usage: { inputTokens: 1200, outputTokens: 90 },
    costUsd: 0.0004,
    cached: false,
    model: 'gpt-fast',
    proposalId: `prop-${requestId}`,
    requestId,
    ...over
  })

  beforeEach(() => {
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Mara climbed the ridge at dusk.' }]
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'The storm had not broken yet.' }] }
        ]
      }
    })
    editor.commands.focus('end')
  })
  afterEach(() => {
    editor.destroy()
  })

  async function askWhatNext(): Promise<PendingWhatNext & { done: Promise<void> }> {
    const asking = store().whatNext()
    await settle()
    const request = whatNexts[whatNexts.length - 1]
    if (!request) throw new Error('nothing was asked')
    return Object.assign(request, { done: asking })
  }

  it('whatNext asks for the open scene without a selection and records the directions as a turn', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    const request = await askWhatNext()
    expect(request.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.any(String) as string,
      before: null
    })
    expect(useAiActivityStore.getState().inflight).toEqual({
      [request.input.requestId]: { feature: 'whatNext', startedAt: expect.any(Number) as number }
    })
    expect(active().messages.slice(2)).toMatchObject([
      { role: 'user', content: WHAT_NEXT_QUESTION },
      { role: 'assistant', content: '', directions: null }
    ])
    // One busy rule: nothing else starts while the conversation waits.
    await store().whatNext()
    await store().recap()
    expect(whatNexts).toHaveLength(1)
    expect(queries).toHaveLength(0)

    request.resolve(whatNextOk(request.input.requestId, { cached: true }))
    await request.done
    expect(store().pending).toEqual({})
    const answer = active().messages[3]
    expect(answer).toMatchObject({
      role: 'assistant',
      content:
        '1. The storm breaks: Rain drives them into the shepherd hut.\n2. A light below: Someone is camped in the valley.',
      directions: DIRECTIONS,
      model: 'gpt-fast',
      costUsd: 0.0004,
      usage: { inputTokens: 1200, outputTokens: 90 },
      proposalId: `prop-${request.input.requestId}`
    })
    expect(store().cached[answer?.id ?? '']).toBe(true)
    expect(settles).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets[0]?.value.items[0]?.messages[3]).toMatchObject({ directions: DIRECTIONS })
  })

  it('whatNext sends the text up to the selection end, tail-capped at the budget', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    editor.commands.setTextSelection({ from: 3, to: 12 })
    const request = await askWhatNext()
    expect(request.input.before).toBe('Mara climbe')

    request.resolve(whatNextOk(request.input.requestId))
    await request.done
    const long = 'word '.repeat(2_000)
    editor.commands.setContent(`<p>${long}</p>`)
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
    const again = await askWhatNext()
    expect(again.input.before).toHaveLength(WHAT_NEXT_CHAR_BUDGET)
    expect(long.trimEnd().endsWith(again.input.before ?? '')).toBe(true)
  })

  it('whatNext toasts without an open scene, and a failure drops the unanswered turn and toasts', async () => {
    await store().load()
    await store().whatNext()
    expect(whatNexts).toHaveLength(0)
    expect(toasts()).toEqual([NO_SCENE_MESSAGE])

    useActiveEditorStore.getState().set('sc-1', editor)
    const request = await askWhatNext()
    request.resolve({
      ok: false,
      code: 'RATE_LIMIT',
      message: 'The provider is busy.',
      nextStep: 'Try again in a minute.',
      requestId: request.input.requestId
    })
    await request.done
    expect(active().messages).toHaveLength(3)
    expect(active().messages.at(-1)).toMatchObject({ role: 'user', content: WHAT_NEXT_QUESTION })
    expect(store().pending).toEqual({})
    expect(toasts()).toEqual([NO_SCENE_MESSAGE, 'The provider is busy. Try again in a minute.'])

    const stopped = await askWhatNext()
    store().stop()
    expect(cancels).toEqual([stopped.input.requestId])
    stopped.resolve(whatNextOk(stopped.input.requestId))
    await stopped.done
    expect(settles).toEqual([
      { id: `prop-${stopped.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(toasts()).toHaveLength(2)
  })

  it('recap asks a read-only agent turn about the scene, or the selection, whatever the chat mode', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    inMode('vibe')
    await store().load()
    const asking = store().recap()
    await settle()
    expect(queries[0]?.input).toMatchObject({
      nodeId: 'sc-1',
      message: RECAP_SCENE_QUESTION,
      access: 'read'
    })
    expect(active().messages.at(-1)).toMatchObject({ role: 'assistant', mode: 'query' })
    queries[0]?.reject(new Error('offline'))
    await asking

    editor.commands.setTextSelection({ from: 1, to: SCENE.indexOf(' The storm') + 1 })
    const again = store().recap()
    await settle()
    expect(queries[1]?.input.message).toBe(
      'What happens in this passage? Give a short recap, citing it: "Mara climbed the ridge at dusk."'
    )
    queries[1]?.reject(new Error('offline'))
    await again
  })

  it('writeDirection sends the direction to the agent with its edit tools, and not in Plan (2026-10-07)', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    const writing = store().writeDirection(DIRECTIONS[0]!)
    await settle()
    expect(queries[0]?.input).toMatchObject({
      nodeId: 'sc-1',
      access: 'write',
      message:
        'Continue the scene in this direction: The storm breaks. Rain drives them into the shepherd hut.'
    })
    const request = queries[0]!
    request.resolve(ok(request.input.requestId, 'Here is the next beat.'))
    await writing
    expect(active().messages.at(-1)).toMatchObject({
      role: 'assistant',
      mode: 'plan',
      content: 'Here is the next beat.'
    })

    inMode('brainstorm')
    await store().writeDirection(DIRECTIONS[0]!)
    expect(queries).toHaveLength(1)
    expect(toasts()).toEqual([PLAN_NO_EDITS_MESSAGE])
  })
})

describe('useAssistantStore sheet lines (F-16.26, decision 3 as the author changed it)', () => {
  const line = (place: 'pinned' | 'ideas' | null) =>
    ({
      kind: 'sheetLine',
      recordId: 'r-mara',
      name: 'Mara',
      place,
      text: 'Hates the sea',
      turn: 'r-turn'
    }) as const

  /** A turn whose answer offers `edits`, in chat mode `mode`. */
  async function answerWith(
    mode: 'vibe' | 'write' | 'brainstorm',
    edits: ReturnType<typeof line>[]
  ): Promise<string> {
    inMode(mode)
    await store().load()
    const asking = store().send('Add to Mara’s sheet that she hates the sea.', { agent: 'write' })
    await settle()
    const request = queries[0]
    if (!request) throw new Error('nothing was asked')
    request.resolve(
      ok(request.input.requestId, 'Done.', {
        changes: edits.map((edit) => ({ edit, violation: null }))
      })
    )
    await asking
    await settle()
    return active().messages.at(-1)?.id ?? ''
  }

  const statuses = (): string[] =>
    (active().messages.at(-1)?.agent?.changes ?? []).map((change) => change.status)

  it('in Auto a pinned line lands at once, and its Undo takes it back', async () => {
    const messageId = await answerWith('vibe', [line('pinned')])
    expect(statuses()).toEqual(['applied'])
    expect(addedLines).toEqual([
      { id: 'r-mara', page: 'pinned', text: 'Hates the sea', turn: 'r-turn' }
    ])
    const change = active().messages.at(-1)?.agent?.changes[0]
    await store().undoChange(messageId, change?.id ?? '')
    expect(removedLines).toEqual([
      { id: 'r-mara', page: 'pinned', index: 0, text: 'Hates the sea', turn: 'r-turn' }
    ])
    expect(statuses()).toEqual(['undone'])
  })

  it('in Ask the line waits; Apply is the one click', async () => {
    const messageId = await answerWith('write', [line('ideas')])
    expect(statuses()).toEqual(['pending'])
    expect(addedLines).toEqual([])
    const change = active().messages.at(-1)?.agent?.changes[0]
    await store().applyChange(messageId, change?.id ?? '')
    expect(addedLines.map((added) => added.page)).toEqual(['ideas'])
    expect(statuses()).toEqual(['applied'])
  })

  it('a line Ms Scribe could not place waits for Idea or Canon, in Auto too, and never in Apply all', async () => {
    const messageId = await answerWith('vibe', [line(null)])
    expect(statuses()).toEqual(['pending'])
    await store().applyAll(messageId)
    await store().applyChange(messageId, active().messages.at(-1)?.agent?.changes[0]?.id ?? '')
    expect(addedLines).toEqual([])
    const change = active().messages.at(-1)?.agent?.changes[0]
    await store().pickSheetPlace(messageId, change?.id ?? '', 'ideas')
    expect(addedLines.map((added) => added.page)).toEqual(['ideas'])
    expect(statuses()).toEqual(['applied'])
    expect(active().messages.at(-1)?.agent?.changes[0]?.edit).toMatchObject({ place: 'ideas' })
  })

  it('Plan never writes a line: the choice says why', async () => {
    const messageId = await answerWith('brainstorm', [line(null)])
    const change = active().messages.at(-1)?.agent?.changes[0]
    await store().pickSheetPlace(messageId, change?.id ?? '', 'pinned')
    expect(addedLines).toEqual([])
    expect(toasts()).toEqual([PLAN_NO_EDITS_MESSAGE])
  })

  it('keeps the Ms Scribe parts of the answer on the turn', async () => {
    inMode('write')
    await store().load()
    const asking = store().send('What did Orrin hear?', { agent: 'write' })
    await settle()
    const request = queries[0]
    if (!request) throw new Error('nothing was asked')
    const scribe = {
      turn: 'answer' as const,
      citations: [],
      notChecked: [[0, 4] as [number, number]],
      unsupported: [],
      scope: null,
      notFound: false,
      retried: false,
      widened: null,
      misses: 0,
      checkUsd: 0.0001
    }
    request.resolve(ok(request.input.requestId, 'Orrin heard it.', { scribe }))
    await asking
    expect(active().messages.at(-1)?.scribe).toEqual(scribe)
    // P3-D23: the turn's cost lists its answer and its quote check apart.
    const turn = active().messages.at(-1)
    expect(turn?.costUsd).toBeCloseTo(0.0003, 10)
    expect(turn?.costParts?.map((part) => part.part)).toEqual(['answer', 'check'])
    expect(turn?.costParts?.[0]?.costUsd).toBeCloseTo(0.0002, 10)
    expect(turn?.costParts?.[1]?.costUsd).toBeCloseTo(0.0001, 10)
  })

  it('lists a read-first apart from the navigator, which may have run no request at all', () => {
    const scribe = {
      turn: 'lookup' as const,
      citations: [],
      notChecked: [],
      unsupported: [],
      scope: null,
      notFound: false,
      retried: false,
      widened: null,
      misses: 0,
      checkUsd: 0.0001
    }
    // A stale value handed over after reading the latest change: no navigator request ran.
    const lookup = costPartsOf({ costUsd: 0.001, readUsd: 0.001 }, { costUsd: 0.0131, scribe })
    expect(lookup?.map((part) => part.part)).toEqual(['read', 'answer', 'check'])
    expect(lookup?.[0]?.costUsd).toBeCloseTo(0.001, 10)
    expect(lookup?.[1]?.costUsd).toBeCloseTo(0.013, 10)
    // Read first, then the navigator: each its own share.
    const both = costPartsOf({ costUsd: 0.003, readUsd: 0.001 }, { costUsd: 0.0131, scribe })
    expect(both?.map((part) => part.part)).toEqual(['read', 'navigator', 'answer', 'check'])
    expect(both?.[1]?.costUsd).toBeCloseTo(0.002, 10)
  })
})
