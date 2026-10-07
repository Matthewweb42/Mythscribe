import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Conversations } from '@shared/chat'
import type {
  AiChatResult,
  AiAgentResult,
  AiRouteResult,
  Channel,
  Input,
  Output
} from '@shared/ipc/contract'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetCritiqueStore, useCritiqueStore } from '@renderer/features/editor/critiqueStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetRewriteStore, useRewriteStore } from '@renderer/features/editor/rewriteStore'
import {
  resetSceneSuggestStore,
  useSceneSuggestStore
} from '@renderer/features/editor/sceneSuggestStore'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import {
  ATTACHMENT_MAX,
  REWRITE_STARTED_MESSAGE,
  resetAssistantStore,
  useAssistantStore,
  withAttachment
} from './assistantStore'
import { resetContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'

const SCENE = 'Mara climbed the ridge as the storm broke over the valley behind her. '.repeat(4)

const STORED: Conversations = {
  active: 'c-1',
  items: [
    {
      id: 'c-1',
      title: 'New conversation',
      mode: 'auto',
      paragraphs: 1,
      messages: [],
      created: '2026-10-06T10:00:00.000Z',
      modified: '2026-10-06T10:00:00.000Z'
    }
  ]
}

const usage = { inputTokens: 90, outputTokens: 8 }

const routed = (
  action: Extract<AiRouteResult, { ok: true }>['action'],
  instruction: string | null = null
): AiRouteResult => ({
  ok: true,
  action,
  instruction,
  routedBy: 'model',
  usage,
  costUsd: 0.00002,
  cached: false,
  model: 'gpt-fast',
  requestId: 'r'
})

let calls: [Channel, unknown][]
let route: AiRouteResult

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'conversations:get':
          return STORED as Output<C>
        case 'conversations:set':
        case 'layout:set':
          return input as Output<C>
        case 'ai:route':
          return { ...route, requestId: (input as Input<'ai:route'>).requestId } as Output<C>
        case 'ai:chat': {
          const result: AiChatResult = {
            ok: true,
            text: 'Because she wants the view.',
            usage,
            costUsd: 0.0003,
            cached: false,
            model: 'gpt-fast',
            flagged: false,
            violation: null,
            proposalId: 'p-chat',
            requestId: (input as Input<'ai:chat'>).requestId
          }
          return result as Output<C>
        }
        case 'ai:agent': {
          const { access, requestId } = input as Input<'ai:agent'>
          const result: AiAgentResult = {
            ok: true,
            answer: access === 'read' ? 'She climbs the ridge.' : 'Because she wants the view.',
            query:
              access === 'read'
                ? { found: true, uncited: true, citations: [], sheets: [], also: [] }
                : null,
            steps: [],
            changes: [],
            dropped: 0,
            usage,
            costUsd: 0.001,
            cached: false,
            model: 'gpt-strong',
            proposalId: access === 'read' ? 'p-query' : 'p-agent',
            requestId
          }
          return result as Output<C>
        }
        // The scene features stay in flight: these tests only look at what started.
        case 'ai:critique':
        case 'ai:rewrite':
        case 'ai:suggestSynopsis':
          return new Promise<Output<C>>(() => {})
        case 'ai:cancel':
          return { cancelled: true } as Output<C>
        case 'proposal:settle':
          return null as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  }
}

const sent = <C extends Channel>(channel: C): Input<C>[] =>
  calls.filter(([c]) => c === channel).map(([, input]) => input as Input<C>)
const turns = () =>
  useAssistantStore.getState().conversations?.items.find((c) => c.id === 'c-1')?.messages ?? []
const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

let editor: Editor

beforeEach(async () => {
  calls = []
  route = routed('chat')
  resetAssistantStore()
  resetDocumentStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetCritiqueStore()
  resetRewriteStore()
  resetSceneSuggestStore()
  resetContinuityStore()
  resetLayoutStore()
  resetFocusStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useAiSettingsStore.setState({ settings: settings() })
  setIpcClient(client())
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
    }
  })
  useActiveEditorStore.getState().set('sc-1', editor)
  await useAssistantStore.getState().load()
})
afterEach(() => {
  resetAssistantStore()
  resetCritiqueStore()
  resetRewriteStore()
  resetSceneSuggestStore()
  resetContinuityStore()
  resetLayoutStore()
  resetActiveEditorStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetDocumentStore()
  useTreeStore.getState().clear()
  editor.destroy()
  setIpcClient(null)
})

describe('Auto conversations (F-5.19 router, 2026-10-06)', () => {
  it('asks the router with the open scene and the selection opening, then runs the action it picked', async () => {
    route = routed('critique')
    editor.commands.setTextSelection({ from: 1, to: 13 })
    await useAssistantStore.getState().send("Give me editor's notes")
    const routes = sent('ai:route')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      nodeId: 'sc-1',
      message: "Give me editor's notes",
      history: [],
      selection: { text: 'Mara climbed' }
    })
    await expect.poll(() => useCritiqueStore.getState().session?.nodeId).toBe('sc-1')
    const [mine, theirs] = turns()
    expect(mine).toMatchObject({ role: 'user', content: "Give me editor's notes" })
    // The turn names the action, says where the notes are, and carries the router's cost.
    expect(theirs).toMatchObject({
      role: 'assistant',
      action: 'critique',
      content: "Editor's notes are above the chat.",
      model: 'gpt-fast',
      costUsd: 0.00002
    })
    expect(useAssistantStore.getState().pending).toEqual({})
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('chat runs the agent with write access on the same turn pair (F-5.22)', async () => {
    await useAssistantStore.getState().send('Why is Mara on the ridge?')
    expect(sent('ai:chat')).toHaveLength(0)
    expect(sent('ai:agent')).toEqual([
      expect.objectContaining({
        access: 'write',
        nodeId: 'sc-1',
        message: 'Why is Mara on the ridge?'
      })
    ])
    expect(turns()).toHaveLength(2)
    expect(turns()[1]).toMatchObject({
      action: 'chat',
      mode: 'plan',
      content: 'Because she wants the view.',
      proposalId: 'p-agent',
      agent: { access: 'write', steps: [], changes: [] }
    })
  })

  it('falls back to chat when the router is off (DISABLED)', async () => {
    route = {
      ok: false,
      code: 'DISABLED',
      message: 'Assistant routing is off.',
      nextStep: '',
      requestId: 'r'
    }
    await useAssistantStore.getState().send('Hello')
    expect(sent('ai:agent')).toHaveLength(1)
    expect(turns()[1]).toMatchObject({ action: 'chat', content: 'Because she wants the view.' })
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('a router failure drops the unanswered turn and says why', async () => {
    route = {
      ok: false,
      code: 'RATE_LIMIT',
      message: 'OpenAI is rate limiting this key.',
      nextStep: 'Wait a minute.',
      requestId: 'r'
    }
    await useAssistantStore.getState().send('Hello')
    expect(sent('ai:agent')).toHaveLength(0)
    expect(turns()).toHaveLength(1)
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'OpenAI is rate limiting this key. Wait a minute.'
    ])
  })

  it('a question about the book goes to the agent, read-only', async () => {
    route = routed('query')
    await useAssistantStore.getState().send('Where does Mara sleep?')
    expect(sent('ai:agent')).toEqual([
      expect.objectContaining({ access: 'read', nodeId: 'sc-1', message: 'Where does Mara sleep?' })
    ])
    expect(turns()[1]).toMatchObject({ action: 'query', mode: 'query', proposalId: 'p-query' })
  })

  it('rewrite rewrites the selection with the instruction as its note', async () => {
    route = routed('rewrite', 'Make it tenser.')
    editor.commands.setTextSelection({ from: 1, to: 70 })
    await useAssistantStore.getState().send('Make this tenser')
    expect(sent('ai:rewrite')).toEqual([
      expect.objectContaining({ nodeId: 'sc-1', from: 1, note: 'Make it tenser.' })
    ])
    expect(useRewriteStore.getState().session).not.toBeNull()
    expect(turns()[1]).toMatchObject({ action: 'rewrite', content: REWRITE_STARTED_MESSAGE })
  })

  it('a suggested synopsis lands in the notes column, which opens', async () => {
    route = routed('synopsis')
    await useAssistantStore.getState().send('Suggest a synopsis')
    await expect
      .poll(() => useSceneSuggestStore.getState().synopsis['sc-1']?.status)
      .toBe('pending')
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
    expect(turns()[1]).toMatchObject({ action: 'synopsis' })
  })

  it('an action the dial forbids answers with the reason and sends nothing', async () => {
    useAiSettingsStore.setState({
      settings: settings({ features: { ...defaultAiSettings().features, critique: false } })
    })
    route = routed('critique')
    await useAssistantStore.getState().send("Editor's notes please")
    expect(sent('ai:critique')).toHaveLength(0)
    expect(turns()[1]).toMatchObject({
      action: 'critique',
      content: "Editor's notes is turned off for this project (Settings, AI tab)"
    })
  })
})

describe('Ask AI attachment (2026-10-06)', () => {
  it('rides on the next message from the composer as a quote, then goes', async () => {
    useAssistantStore.getState().attach('  The storm broke at dusk.  ')
    expect(useAssistantStore.getState().attachment).toBe('The storm broke at dusk.')
    await useAssistantStore.getState().send('What does this foreshadow?')
    expect(sent('ai:route')[0]?.message).toBe(
      'What does this foreshadow?\n\nPassage:\n"The storm broke at dusk."'
    )
    expect(useAssistantStore.getState().attachment).toBeNull()
  })

  it('is cut to its cap, and blank text detaches', () => {
    useAssistantStore.getState().attach('x'.repeat(ATTACHMENT_MAX + 50))
    expect(useAssistantStore.getState().attachment).toHaveLength(ATTACHMENT_MAX)
    useAssistantStore.getState().attach('   ')
    expect(useAssistantStore.getState().attachment).toBeNull()
  })

  it('never pushes the message past the cap', () => {
    expect(withAttachment('a'.repeat(5000), 'quote')).toHaveLength(4000)
    expect(withAttachment('hello', null)).toBe('hello')
  })
})
