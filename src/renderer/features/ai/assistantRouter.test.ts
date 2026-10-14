import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { RouteEdit } from '@shared/assistantRoute'
import type { Conversations } from '@shared/chat'
import type { EditPassSummary } from '@shared/editPass'
import { EDIT_ASK_QUESTION } from '@shared/editRequest'
import type {
  AiChatResult,
  AiAgentResult,
  AiNavigateResult,
  AiRouteResult,
  Channel,
  Input,
  Output
} from '@shared/ipc/contract'
import type { FindingView } from '@shared/memory/findings'
import type { FindingsView } from '@shared/memory/views'
import type { InstantCard } from '@shared/scribe'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetCritiqueStore, useCritiqueStore } from '@renderer/features/editor/critiqueStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetRewriteStore, useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { resetEditPassStore, useEditPassStore } from '@renderer/features/editPass/editPassStore'
import {
  resetSceneSuggestStore,
  useSceneSuggestStore
} from '@renderer/features/editor/sceneSuggestStore'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import {
  ATTACHMENT_MAX,
  PLAN_NO_EDITS_MESSAGE,
  REWRITE_STARTED_MESSAGE,
  resetAssistantStore,
  useAssistantStore,
  withAttachment
} from './assistantStore'
import { resetContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'
import { INSTANT_CARD_LABEL } from './instantCardText'

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
  instruction: string | null = null,
  edit: RouteEdit | null = null
): AiRouteResult => ({
  ok: true,
  action,
  instruction,
  edit,
  routedBy: 'model',
  usage,
  costUsd: 0.00002,
  cached: false,
  model: 'gpt-fast',
  requestId: 'r'
})

let calls: [Channel, unknown][]
let route: AiRouteResult
/** F-16.25: what `ai:navigate` answers in a story memory v2 project. */
let navigate: AiNavigateResult
const NO_FINDINGS: FindingsView = {
  open: [],
  unclear: [],
  counts: { unjudged: 0, held: 0, hidden: 0, open: 0, unclear: 0, fine: 0 },
  waiting: 0,
  judging: false
}
/** F-16.27 (P4-D23): what `memory:findings` answers in a story memory v2 project. */
let findings: FindingsView = NO_FINDINGS

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
        case 'memory:findings':
          return findings as Output<C>
        case 'ai:navigate':
          return {
            ...navigate,
            requestId: (input as Input<'ai:navigate'>).requestId
          } as Output<C>
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
            organise: null,
            scribe: null,
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
        case 'editPass:start': {
          const start = input as Input<'editPass:start'>
          return { ok: true, pass: passSummary(start) } as Output<C>
        }
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

/** What main answers an edit pass start with: the pass, running. */
function passSummary(start: Input<'editPass:start'>): EditPassSummary {
  return {
    id: `pass-${calls.length}`,
    type: start.type,
    instruction: start.instruction,
    excerpt: start.excerpt != null,
    status: 'running',
    nodeIds: start.nodeIds,
    doneNodeIds: [],
    currentNodeId: null,
    model: 'gpt-strong',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    finishedAt: null
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
  findings = NO_FINDINGS
  route = routed('chat')
  navigate = {
    ok: true,
    kind: 'route',
    action: 'chat',
    instruction: null,
    edit: null,
    routedBy: 'model',
    usage,
    costUsd: 0.00002,
    cached: false,
    model: 'gpt-fast',
    requestId: 'r'
  }
  useProjectStore.setState({ current: null })
  resetAssistantStore()
  resetDocumentStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetAiSettingsStore()
  resetCritiqueStore()
  resetRewriteStore()
  resetEditPassStore()
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
  useProjectStore.setState({ current: null })
  resetAssistantStore()
  resetCritiqueStore()
  resetRewriteStore()
  resetEditPassStore()
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

describe('edit requests (F-5.26)', () => {
  const editRoute = (edit: RouteEdit, instruction: string | null = null): AiRouteResult =>
    routed('editPass', instruction, edit)

  it('a vague request asks which kind of edit, with the quick picks, and starts nothing', async () => {
    route = editRoute({ pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Make this scene better')
    expect(sent('editPass:start')).toHaveLength(0)
    expect(turns()[1]).toMatchObject({
      action: 'editPass',
      content: EDIT_ASK_QUESTION,
      model: 'gpt-fast',
      edit: {
        target: { kind: 'scene', nodeIds: ['sc-1'], title: 'Scene 1', excerpt: null },
        choices: ['line', 'developmental', 'dialogue', 'proofread', 'critique'],
        picked: null,
        passId: null
      }
    })
  })

  it('a pick runs its pass on the target and records it on the turn', async () => {
    route = editRoute({ pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Improve this')
    const id = turns()[1]?.id ?? ''
    await useAssistantStore.getState().pickEdit(id, 'line')
    expect(sent('editPass:start')).toEqual([
      { type: 'line', instruction: null, nodeIds: ['sc-1'], excerpt: null }
    ])
    expect(turns()[1]?.edit?.picked).toBe('line')
    expect(turns()[1]?.edit?.passId).toBe(useEditPassStore.getState().startedHere)
    expect(turns()[1]?.content).toContain('Line edit started on “Scene 1”')
    // A second pick on the same turn starts nothing more.
    await useAssistantStore.getState().pickEdit(id, 'proofread')
    expect(sent('editPass:start')).toHaveLength(1)
  })

  it('Dialogue runs a custom pass carrying the dialogue instruction', async () => {
    route = editRoute({ pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Improve this')
    await useAssistantStore.getState().pickEdit(turns()[1]?.id ?? '', 'dialogue')
    expect(sent('editPass:start')[0]?.type).toBe('custom')
    expect(sent('editPass:start')[0]?.instruction?.startsWith('Dialogue pass: ')).toBe(true)
  })

  it('with a selection, the pass reads only the selected passage', async () => {
    route = editRoute({ pass: 'proofread', target: 'selection', chapter: null })
    editor.commands.setTextSelection({ from: 1, to: 40 })
    await useAssistantStore.getState().send('Proofread this')
    expect(sent('editPass:start')).toEqual([
      {
        type: 'proofread',
        instruction: null,
        nodeIds: ['sc-1'],
        excerpt: SCENE.slice(0, 39)
      }
    ])
    expect(turns()[1]?.content).toContain('Proofread started on the selection in “Scene 1”')
  })

  it('a specific request on a named chapter runs at once over its scenes', async () => {
    route = editRoute({ pass: 'proofread', target: 'chapter', chapter: 'chapter 3' })
    await useAssistantStore.getState().send('Proofread chapter 3')
    expect(sent('editPass:start')).toEqual([
      { type: 'proofread', instruction: null, nodeIds: ['sc-3'], excerpt: null }
    ])
    expect(turns()[1]?.edit).toMatchObject({
      target: { kind: 'chapter', title: 'Chapter 3' },
      picked: 'proofread'
    })
  })

  it("this chapter is the open scene's; a chapter that is not there says so", async () => {
    route = editRoute({ pass: 'developmental', target: 'chapter', chapter: null })
    await useAssistantStore.getState().send('Fix the pacing of this chapter')
    expect(sent('editPass:start')[0]).toMatchObject({ type: 'developmental', nodeIds: ['sc-1'] })

    route = editRoute({ pass: 'line', target: 'chapter', chapter: 'Chapter 40' })
    await useAssistantStore.getState().send('Tighten chapter 40')
    expect(sent('editPass:start')).toHaveLength(1)
    expect(turns()[3]?.content).toBe('No chapter called “Chapter 40” in the manuscript.')
  })

  it('a custom request carries the instruction; a chapter is not offered Editor’s notes', async () => {
    route = editRoute({ pass: 'custom', target: 'scene', chapter: null }, 'Cut the adverbs.')
    await useAssistantStore.getState().send('Cut the adverbs')
    expect(sent('editPass:start')[0]).toMatchObject({
      type: 'custom',
      instruction: 'Cut the adverbs.'
    })
    useEditPassStore.setState({ byId: {}, ids: [] })
    route = editRoute({ pass: 'ask', target: 'chapter', chapter: null })
    await useAssistantStore.getState().send('Polish this chapter')
    expect(turns()[3]?.edit?.choices).not.toContain('critique')
  })

  it('a pass already running answers with the reason and keeps the choice to try later', async () => {
    route = editRoute({ pass: 'line', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Tighten the prose')
    await useAssistantStore.getState().send('Tighten the prose again')
    expect(sent('editPass:start')).toHaveLength(1)
    expect(turns()[3]).toMatchObject({
      content: 'An edit pass is already running. Stop it or wait for it to finish.',
      edit: { choices: ['line'], picked: null }
    })
  })

  it('in Plan an edit request is answered by the read-only chat, and a pick is refused', async () => {
    useAiSettingsStore.setState({ settings: settings({ chatMode: 'plan' }) })
    route = editRoute({ pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Make this scene better')
    expect(sent('ai:agent')).toEqual([expect.objectContaining({ access: 'read' })])
    expect(turns()[1]?.edit).toBeNull()

    useAiSettingsStore.setState({ settings: settings() })
    await useAssistantStore.getState().send('Make this scene better')
    useAiSettingsStore.setState({ settings: settings({ chatMode: 'plan' }) })
    await useAssistantStore.getState().pickEdit(turns()[3]?.id ?? '', 'line')
    expect(sent('editPass:start')).toHaveLength(0)
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toContain(PLAN_NO_EDITS_MESSAGE)
  })

  it('Editor’s notes from the quick picks opens the critique on the scene', async () => {
    route = editRoute({ pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Make this better')
    await useAssistantStore.getState().pickEdit(turns()[1]?.id ?? '', 'critique')
    await expect.poll(() => useCritiqueStore.getState().session?.nodeId).toBe('sc-1')
    expect(turns()[1]).toMatchObject({
      content: "Editor's notes are above the chat.",
      edit: { picked: 'critique', passId: null }
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

describe('story memory v2: Ms Scribe’s navigator in place of the router (F-16.24, F-16.25)', () => {
  beforeEach(() => {
    useProjectStore.setState({
      current: {
        id: 'p-2',
        name: 'Memory',
        format: 'novel',
        path: '/books/Memory.mythscribe',
        created: 'c',
        modified: 'm',
        lastOpened: 'l',
        schemaVersion: 37,
        storyMemory: 'v2'
      }
    })
  })

  const routedV2 = (
    action: Extract<AiNavigateResult, { kind: 'route' }>['action'],
    edit: RouteEdit | null = null
  ): AiNavigateResult => ({
    ok: true,
    kind: 'route',
    action,
    instruction: null,
    edit,
    routedBy: 'model',
    usage,
    costUsd: 0.0006,
    cached: false,
    model: 'gpt-fast',
    requestId: 'r'
  })

  it('asks ai:navigate (never ai:route) with the open scene, the last turns and the caret focus', async () => {
    editor.commands.setTextSelection({ from: 1, to: 13 })
    await useAssistantStore.getState().send('Who is on the ridge?')
    expect(sent('ai:route')).toHaveLength(0)
    expect(sent('ai:navigate')).toEqual([
      expect.objectContaining({
        nodeId: 'sc-1',
        message: 'Who is on the ridge?',
        history: [],
        focus: { beforeCaret: '', selection: 'Mara climbed' }
      })
    ])
  })

  it('keeps F-5.26: a vague request asks which edit with the five quick picks; Tighten prose runs one pass', async () => {
    navigate = routedV2('editPass', { pass: 'ask', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Make this scene better.')
    expect(sent('editPass:start')).toHaveLength(0)
    expect(turns()[1]).toMatchObject({
      action: 'editPass',
      content: EDIT_ASK_QUESTION,
      model: 'gpt-fast',
      costUsd: 0.0006,
      edit: {
        choices: ['line', 'developmental', 'dialogue', 'proofread', 'critique'],
        picked: null
      }
    })
    await useAssistantStore.getState().pickEdit(turns()[1]?.id ?? '', 'line')
    expect(sent('editPass:start')).toEqual([
      { type: 'line', instruction: null, nodeIds: ['sc-1'], excerpt: null }
    ])
    expect(sent('ai:route')).toHaveLength(0)
  })

  it('runs every other route action as before, and Plan keeps edits out', async () => {
    navigate = routedV2('critique')
    await useAssistantStore.getState().send("Give me editor's notes")
    await expect.poll(() => useCritiqueStore.getState().session?.nodeId).toBe('sc-1')
    useAiSettingsStore.setState({ settings: settings({ chatMode: 'plan' }) })
    navigate = routedV2('editPass', { pass: 'line', target: 'scene', chapter: null })
    await useAssistantStore.getState().send('Tighten the prose')
    expect(sent('editPass:start')).toHaveLength(0)
    expect(sent('ai:agent')).toEqual([expect.objectContaining({ access: 'read' })])
    // No navigation: Ms Scribe answers from Step 0's evidence.
    expect(sent('ai:agent')[0]?.navigation).toBeUndefined()
  })

  it('answers a consistency check from the open scene’s findings, with no request (P4-D23)', async () => {
    navigate = routedV2('continuity')
    await useAssistantStore.getState().send('Check this scene for consistency')
    expect(sent('memory:findings')).toEqual([{ nodeId: 'sc-1' }])
    expect(calls.some(([channel]) => channel === 'ai:continuity')).toBe(false)
    expect(turns()[1]?.content).toContain('No possible contradictions found in this scene so far')
    const side = (value: string, label: string, nodeId: string): FindingView['a'] => ({
      kind: 'claim',
      ref: label,
      nodeId,
      para: 0,
      quote: `Mara's eyes were ${value}`,
      value,
      voice: 'narration',
      mode: 'now',
      label,
      open: { kind: 'scene', id: nodeId, para: 0 }
    })
    const open: FindingView = {
      id: 'f1',
      rule: 'C1',
      variant: null,
      recordId: 'r-mara',
      name: 'Mara Vell',
      slot: 'eyes',
      slotLabel: 'Eyes',
      a: side('grey', '1.1', 'sc-0'),
      b: side('brown', '1.2', 'sc-1'),
      state: 'open',
      verdictAb: 'c',
      verdictBa: 'c',
      confirmed: false,
      why: 'values differ',
      costUsd: 0.0001,
      actions: { right: { a: true, b: true }, updateNote: false, notFlashback: null }
    }
    findings = { ...findings, open: [open] }
    await useAssistantStore.getState().send('Check this scene for consistency')
    expect(turns()[3]?.content).toContain('Mara Vell’s eyes: grey (1.1) · brown (1.2)')
    expect(sent('ai:navigate')).toHaveLength(2)
  })

  it('shows an instant card as the turn’s text with no AI call', async () => {
    const card: InstantCard = {
      kind: 'slot',
      recordId: 'm',
      name: 'Mara',
      slot: 'eyes',
      label: 'Eyes',
      value: 'grey',
      claimId: 'c1',
      quote: 'her grey eyes',
      ref: '1.1',
      nodeId: 'sc-1',
      para: 0,
      since: null,
      lastStated: false,
      asOfRef: '1.1',
      readFirst: null
    }
    navigate = {
      ok: true,
      kind: 'instant',
      card,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: false,
      model: null,
      requestId: 'r'
    }
    await useAssistantStore.getState().send('Mara’s eyes?')
    expect(sent('ai:agent')).toHaveLength(0)
    expect(turns()[1]).toMatchObject({
      content: `Mara · Eyes: grey (1.1)\n\n${INSTANT_CARD_LABEL}`,
      card,
      costUsd: 0,
      action: 'query'
    })
    expect(useAssistantStore.getState().pending).toEqual({})
  })

  it('keeps a who-knows card’s scoped absence out of the turn’s text, so no later request carries it (P2b rule 9)', async () => {
    const card: InstantCard = {
      kind: 'whoKnows',
      secretId: 's-map',
      label: 'the sold map',
      readersSince: { nodeId: 'sc-1', ref: '1.1' },
      holders: [
        {
          knowerId: 'r-orrin',
          secretId: 's-map',
          how: 'overheard',
          fromId: null,
          source: 'claim',
          line: 'counts',
          claimId: 'k1',
          nodeId: 'sc-1',
          ref: '1.1',
          para: 0,
          voice: 'narration',
          mode: 'now',
          speakerId: null,
          stale: false,
          later: false
        }
      ],
      checkedUpTo: { nodeId: 'sc-1', ref: '1.1' },
      asOfRef: '1.1',
      readFirst: null
    }
    navigate = {
      ok: true,
      kind: 'instant',
      card,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: false,
      model: null,
      requestId: 'r'
    }
    await useAssistantStore.getState().send('Who knows about the sold map?')
    expect(turns()[1]?.card).toEqual(card)
    expect(turns()[1]?.content).toContain('Who knows the sold map')
    await useAssistantStore.getState().send('And the ledger?')
    const history = sent('ai:navigate')[1]?.history ?? []
    expect(history.map((turn) => turn.content)).toContain(turns()[1]?.content)
    for (const turn of history) {
      expect(turn.content).not.toMatch(/no (other )?scene shows|checked up to|not checked/i)
    }
  })

  it('hands an answer turn to Ms Scribe with the navigation; the steps and the cost are both calls’', async () => {
    const navigation = {
      turn: 'answer' as const,
      evidence: [{ kind: 'outline' as const }],
      scope: null,
      terms: ['ridge'],
      hits: []
    }
    navigate = {
      ok: true,
      kind: 'answer',
      action: 'query',
      navigation,
      steps: [{ tool: 'search', label: "Searching 'ridge'…" }],
      routedBy: 'model',
      readUsd: 0,
      usage: { inputTokens: 2_000, outputTokens: 40 },
      costUsd: 0.0005,
      cached: false,
      model: 'gpt-fast',
      requestId: 'r'
    }
    await useAssistantStore.getState().send('When does Mara first climb the ridge?')
    expect(sent('ai:agent')).toEqual([
      expect.objectContaining({
        access: 'read',
        navigation,
        message: 'When does Mara first climb the ridge?'
      })
    ])
    expect(turns()[1]).toMatchObject({
      action: 'query',
      mode: 'query',
      model: 'gpt-strong',
      costUsd: 0.0015,
      usage: { inputTokens: 2_090, outputTokens: 48 },
      agent: {
        steps: [{ tool: 'search', label: "Searching 'ridge'…" }]
      }
    })
  })

  it('falls back to Ms Scribe on Step 0’s evidence when the chat is off for routing (DISABLED), and settles other failures', async () => {
    navigate = { ok: false, code: 'DISABLED', message: 'off', nextStep: '', requestId: 'r' }
    await useAssistantStore.getState().send('Hello')
    expect(sent('ai:agent')).toEqual([expect.objectContaining({ access: 'write' })])
    expect(sent('ai:agent')[0]?.navigation).toBeUndefined()
    navigate = {
      ok: false,
      code: 'RATE_LIMIT',
      message: 'OpenAI is rate limiting this key.',
      nextStep: 'Wait a minute.',
      requestId: 'r'
    }
    await useAssistantStore.getState().send('Hello again')
    expect(sent('ai:agent')).toHaveLength(1)
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toContain(
      'OpenAI is rate limiting this key. Wait a minute.'
    )
  })
})
