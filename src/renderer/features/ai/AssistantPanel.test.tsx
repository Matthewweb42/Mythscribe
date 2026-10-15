import { Editor } from '@tiptap/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { SUGGESTION_ROTATE_MS } from '@shared/assistantSuggestions'
import type { Conversation, Conversations } from '@shared/chat'
import type { AgentChange } from '@shared/agent'
import type { ClearOption } from '@shared/bibleClear'
import type { RouteAction } from '@shared/assistantRoute'
import type { AiAgentResult, AiScribeResult, Channel, Input, Output } from '@shared/ipc/contract'
import type { EditChange, EditPassSummary } from '@shared/editPass'
import { EDIT_ASK_QUESTION, type EditTurn } from '@shared/editRequest'
import { bundledPricing } from '@shared/hostedPricing'
import { resetAccountStore, useAccountStore } from '@renderer/features/account/accountStore'
import { resetEditPassStore, useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { QUERY_NOT_FOUND, type QueryTurn } from '@shared/query'
import type { InstantCard as InstantCardData, ScribeTurn } from '@shared/scribe'
import { LAYOUT_LIMITS, defaultLayout } from '@shared/layout'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetLibraryStore } from '@renderer/features/library/libraryStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { DockColumn } from '@renderer/features/shell/Dock'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import {
  resetOpenNotebookPage,
  useOpenNotebookPageStore
} from '@renderer/features/notebook/openPage'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore } from './aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import {
  AI_OFF_MESSAGE,
  AssistantPanel,
  AssistantToggleButton,
  NO_DIRECTIONS_MESSAGE
} from './AssistantPanel'
import {
  AGENT_NOTICE,
  NO_SCENE_MESSAGE,
  PLAN_NO_EDITS_MESSAGE,
  resetAssistantStore,
  useAssistantStore
} from './assistantStore'
import { CONVERSATION_BUSY_MESSAGE } from './aiActions'
import { continuityTree } from './continuityFixture'
import { resetContinuityStore, useContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'

/** Notes redesign phase 1: a v1 chat turn's request to Ms Scribe. */
interface PendingScribe {
  input: Input<'ai:scribe'>
  resolve: (result: AiScribeResult) => void
}

interface PendingQuery {
  input: Input<'ai:agent'>
  resolve: (result: AiAgentResult) => void
}

let queries: PendingQuery[]
let scribes: PendingScribe[]
/** What the fake router picks for every message (F-5.19); chat unless a test says otherwise. */
let routeAction: RouteAction
/** The zod input shape: a turn stored before F-5.7 carries no `query`. */
let sets: Input<'conversations:set'>[]
let cancels: string[]
/** F-5.25: what the clear card's Delete sent. */
let clears: Input<'bible:clear'>[]
/** F-5.26: the edit passes the chat's edit choices started. */
let passStarts: Input<'editPass:start'>[]

/** An edit pass as main reports it (F-5.26). */
function editPassSummary(over: Partial<EditPassSummary> = {}): EditPassSummary {
  return {
    id: 'pass-1',
    type: 'line',
    instruction: null,
    excerpt: false,
    status: 'running',
    nodeIds: ['sc-1'],
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
    finishedAt: null,
    ...over
  }
}

const PASS_CHANGE: EditChange = {
  id: 'ec-1',
  passId: 'pass-1',
  nodeId: 'sc-1',
  kind: 'change',
  position: 0,
  original: 'very slowly',
  replacement: 'slowly',
  rationale: 'Tighter.',
  category: null,
  flagged: false,
  violation: null,
  status: 'pending',
  proposalId: 'p-pass'
}

/**
 * `conversations:get` answers with `stored`; writes record; `ai:route` picks `routeAction` at
 * once; `ai:agent` resolves when the test says so; `aiSettings:set` echoes.
 */
function install(stored: Conversations): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'conversations:get') return stored as Output<C>
      if (channel === 'conversations:set') {
        sets.push(input as Input<'conversations:set'>)
        return input as Output<C>
      }
      if (channel === 'ai:route') {
        return {
          ok: true,
          action: routeAction,
          instruction: null,
          edit: null,
          routedBy: 'local',
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          cached: false,
          model: null,
          requestId: (input as Input<'ai:route'>).requestId
        } as Output<C>
      }
      if (channel === 'aiSettings:set') return input as Output<C>
      if (channel === 'ai:agent') {
        return new Promise<Output<C>>((resolve) => {
          queries.push({
            input: input as Input<'ai:agent'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'ai:scribe') {
        return new Promise<Output<C>>((resolve) => {
          scribes.push({
            input: input as Input<'ai:scribe'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'proposal:settle') return null as Output<C>
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: true } as Output<C>
      }
      if (channel === 'bible:clear') {
        clears.push(input as Input<'bible:clear'>)
        return {
          entry: {
            id: 'ch-1',
            runId: 'chat:m-2',
            createdAt: '2026-10-10T10:00:00.000Z',
            nodeId: null,
            quote: null,
            kind: 'clear',
            entityId: null,
            label: 'Cleared 2 sheets',
            status: 'applied',
            source: 'chat',
            undoable: true
          },
          counts: { sheets: 2, tags: 0, library: 0, notes: 0 },
          removedEntityIds: [],
          removedTagIds: [],
          removedLibraryIds: [],
          notesNodeIds: []
        } as Output<C>
      }
      if (channel === 'library:list') return [] as Output<C>
      if (channel === 'editPass:start') {
        const start = input as Input<'editPass:start'>
        passStarts.push(start)
        return {
          ok: true,
          pass: editPassSummary({ type: start.type, nodeIds: start.nodeIds })
        } as Output<C>
      }
      if (channel === 'editPass:get') {
        return {
          pass: editPassSummary({ status: 'done' }),
          changes: [PASS_CHANGE],
          titles: { 'sc-1': 'Scene 1' }
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  over: Partial<Conversation['messages'][number]> = {}
): Conversation['messages'][number] => ({
  id,
  role,
  content,
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
  sources: null,
  ...over
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c-1',
  title: 'Why the ridge?',
  mode: 'plan',
  paragraphs: 1,
  messages: [
    message('m-1', 'user', 'Why the ridge?'),
    message('m-2', 'assistant', 'Because Mara wants the view.', {
      proposalId: 'p-1',
      model: 'gpt-fake',
      costUsd: 0.0002,
      mode: 'plan'
    })
  ],
  created: '2026-09-15T10:00:00.000Z',
  modified: '2026-09-15T10:00:01.000Z',
  ...over
})

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...defaultAiSettings(),
  dial: 1,
  ...over
})

/** Ms Scribe's answer (notes redesign phase 1) with no lookups, changes, or sources. */
const scribeOk = (
  requestId: string,
  answer: string,
  over: Partial<Extract<AiScribeResult, { ok: true }>> = {}
): AiScribeResult => ({
  ok: true,
  answer,
  steps: [],
  changes: [],
  sources: { scenes: [], pages: [] },
  usage: { inputTokens: 200, outputTokens: 40 },
  costUsd: 0.0003,
  cached: true,
  model: 'gpt-fake',
  proposalId: `prop-${requestId}`,
  requestId,
  ...over
})

const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Ms Scribe' })
const log = (): HTMLElement => screen.getByRole('log', { name: 'Messages' })
const tabs = (): HTMLElement[] =>
  within(screen.getByRole('tablist', { name: 'Conversations' })).getAllByRole('tab')
const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' })
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' })
const stopButton = (): HTMLElement => screen.getByRole('button', { name: 'Stop' })
const turns = (): HTMLElement[] => within(log()).queryAllByTestId('chat-turn')
const modals = (): string[] => useDialogStore.getState().modals.map((m) => m.options.title)

function Host(): React.JSX.Element {
  return (
    <div>
      <AssistantToggleButton />
      <div className="flex">
        <div>editor</div>
        <DockColumn column={['assistant']} side="left" render={() => <AssistantPanel />} />
      </div>
      <DialogHost />
    </div>
  )
}

/** Renders with the panel open and the stored conversations loaded. */
async function mountOpen(
  stored: Conversations = { active: 'c-1', items: [conversation()] },
  ai: AiSettings | null = settings()
): Promise<void> {
  install(stored)
  useAiSettingsStore.setState({ settings: ai })
  act(() => useLayoutStore.getState().toggle('assistant'))
  render(<Host />)
  await act(async () => {
    await useAssistantStore.getState().load()
  })
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1000)
  queries = []
  scribes = []
  resetOpenNotebookPage()
  routeAction = 'chat'
  sets = []
  cancels = []
  clears = []
  passStarts = []
  resetChangesStore()
  resetLibraryStore()
  resetLayoutStore()
  resetAssistantStore()
  resetContinuityStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetActiveEditorStore()
  resetProposalStore()
  resetPendingSaves()
  resetViewStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetViewStore()
  resetChangesStore()
  resetLibraryStore()
  resetLayoutStore()
  resetAssistantStore()
  resetContinuityStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  vi.unstubAllGlobals()
})

describe('AssistantPanel (F-5.4)', () => {
  it('starts closed; the header button and Ctrl+K toggle it and report aria-pressed', async () => {
    install({ active: null, items: [] })
    render(<Host />)
    const button = screen.getByRole('button', { name: 'Ms Scribe' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()

    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(panel()).toBeInTheDocument()
    expect(screen.getByTestId('dock-column').style.width).toBe(
      `${defaultLayout().assistant.size * 100}vw`
    )
    expect(screen.getByRole('heading', { name: 'Ms Scribe' })).toBeInTheDocument()

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
    await userEvent.keyboard('{Control>}k{/Control}')
    expect(panel()).toBeInTheDocument()
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('goes by the name set in Settings: the toggle, the panel, its heading, grip, and resize handle (F-7.13)', async () => {
    install({ active: null, items: [] })
    useViewStore.setState({ assistantName: 'Quill' })
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Quill' }))
    expect(screen.getByRole('complementary', { name: 'Quill' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Quill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move Quill' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize Quill' })).toBeInTheDocument()
  })

  it('resizes by its left-edge handle with the arrow keys, clamped to its limits', async () => {
    await mountOpen()
    const handle = screen.getByRole('separator', { name: 'Resize Ms Scribe' })
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '30')
    expect(handle).toHaveAttribute('aria-valuemin', '20')
    expect(handle).toHaveAttribute('aria-valuemax', '50')
    handle.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(useLayoutStore.getState().layout.assistant.size).toBeCloseTo(0.3 + 16 / 1000)
    for (let i = 0; i < 20; i++) await userEvent.keyboard('{ArrowRight}')
    expect(useLayoutStore.getState().layout.assistant.size).toBe(LAYOUT_LIMITS.assistant[0])
  })

  it('shows the conversation tabs, the turns with the cost line, and the composer', async () => {
    await mountOpen()
    expect(tabs().map((t) => t.textContent)).toEqual(['Why the ridge?'])
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Close Why the ridge?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeEnabled()
    const [mine, theirs] = turns()
    expect(mine).toHaveAttribute('data-role', 'user')
    expect(mine).toHaveTextContent('Why the ridge?')
    expect(theirs).toHaveAttribute('data-role', 'assistant')
    expect(theirs).toHaveTextContent('Because Mara wants the view.')
    // A turn stored before F-5.9 kept no tokens, so the line is the model and the cost alone.
    expect(within(theirs!).getByTestId('chat-turn-cost')).toHaveTextContent('gpt-fake · $0.0002')
    expect(within(theirs!).getByTestId('chat-turn-cost')).not.toHaveTextContent(' in · ')
    expect(within(mine!).queryByTestId('chat-turn-cost')).not.toBeInTheDocument()
    // 2026-10-15: exactly Brainstorm, Write, Vibe under the box, the project's mode checked
    // (Write by default), each with its meaning as the tooltip; no Off, no paragraph count.
    const modes = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(
      within(modes)
        .getAllByRole('radio')
        .map((radio) => radio.textContent)
    ).toEqual(['Brainstorm', 'Write', 'Vibe'])
    expect(within(modes).getByRole('radio', { name: 'Write' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(modes).getByRole('radio', { name: 'Brainstorm' })).toHaveAttribute(
      'title',
      expect.stringContaining('changes nothing') as string
    )
    expect(screen.getByRole('button', { name: 'Whole book' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByRole('radio', { name: /off/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'AI switch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Paragraphs' })).not.toBeInTheDocument()
    expect(box()).toBeEnabled()
    expect(sendButton()).toBeDisabled()
    expect(screen.queryByTestId('assistant-disabled')).not.toBeInTheDocument()
  })

  it('Enter sends, Shift+Enter breaks the line, and the answer lands in the log with its cost', async () => {
    await mountOpen()
    await userEvent.type(box(), 'What next{Shift>}{Enter}{/Shift}for Mara?')
    expect(box()).toHaveValue('What next\nfor Mara?')
    expect(sendButton()).toBeEnabled()
    await userEvent.keyboard('{Enter}')
    expect(scribes).toHaveLength(1)
    expect(scribes[0]?.input).toMatchObject({
      message: 'What next\nfor Mara?',
      mode: 'write',
      wholeBook: false,
      nodeId: null
    })
    expect(box()).toHaveValue('')
    expect(turns()).toHaveLength(4)
    expect(within(turns()[3]!).getByTestId('chat-pending')).toHaveTextContent('Thinking…')
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(stopButton()).toBeInTheDocument()

    await act(async () => {
      scribes[0]?.resolve(scribeOk(scribes[0].input.requestId, 'She climbs.'))
    })
    expect(turns()[3]).toHaveTextContent('She climbs.')
    expect(within(turns()[3]!).getByTestId('chat-turn-cost')).toHaveTextContent(
      'gpt-fake · $0.0003 · 200 in · 40 out · cached'
    )
    expect(screen.queryByTestId('chat-pending')).not.toBeInTheDocument()
    await userEvent.type(box(), 'more')
    expect(sendButton()).toBeEnabled()
  })

  it('Stop takes Send’s place while a turn is in flight; clicking it drops the thinking turn, keeps the author’s, and stops the request (F-5.10)', async () => {
    await mountOpen()
    await userEvent.type(box(), 'What next?{Enter}')
    expect(turns()).toHaveLength(4)
    const stop = stopButton()
    expect(stop).toHaveAttribute('data-testid', 'assistant-stop')
    expect(stop).toHaveAttribute('title', 'Stop this answer')
    await userEvent.click(stop)
    expect(cancels).toEqual([scribes[0]?.input.requestId])
    expect(turns()).toHaveLength(3)
    expect(turns()[2]).toHaveAttribute('data-role', 'user')
    expect(turns()[2]).toHaveTextContent('What next?')
    expect(screen.queryByTestId('chat-pending')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(sendButton()).toHaveAttribute('data-testid', 'assistant-send')
    expect(sendButton()).toBeDisabled() // the box is empty; typing enables it again
    await act(async () => {
      scribes[0]?.resolve({
        ok: false,
        code: 'CANCELLED',
        message: 'The request was stopped.',
        nextStep: 'Send it again whenever you like.',
        requestId: scribes[0].input.requestId
      })
    })
    expect(turns()).toHaveLength(3)
    expect(useDialogStore.getState().toasts).toEqual([])
    await userEvent.type(box(), 'again')
    expect(sendButton()).toBeEnabled()
  })

  it("picks the project's chat mode with a click or the arrow keys, for every tab, and still shows a stored Author turn as its notice (2026-10-07)", async () => {
    await mountOpen()
    const vibe = screen.getByRole('radio', { name: 'Vibe' })
    await userEvent.click(vibe)
    expect(vibe).toHaveAttribute('aria-checked', 'true')
    expect(useAiSettingsStore.getState().settings?.chatMode).toBe('vibe')
    // Vibe turns ghost text on as it is picked.
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(true)
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Brainstorm' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('radio', { name: 'Brainstorm' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Write' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    expect(useAiSettingsStore.getState().settings?.chatMode).toBe('brainstorm')
    // Leaving Vibe keeps ghost text as it is.
    expect(useAiSettingsStore.getState().settings?.ghostText.enabled).toBe(true)
    // One setting, not one per tab: a new conversation shows the same mode.
    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(screen.getByRole('radio', { name: 'Brainstorm' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    // Brainstorm is sent as the mode; Ms Scribe changes nothing in it.
    await userEvent.type(box(), 'Brainstorm the ending{Enter}')
    expect(scribes[0]?.input.mode).toBe('brainstorm')

    // An Author turn stored before 2026-10-07 reads as the notice, never as its text.
    act(() =>
      useAssistantStore.setState({
        conversations: {
          active: 'c-1',
          items: [
            conversation({
              messages: [
                message('m-1', 'user', 'Continue'),
                message('m-2', 'assistant', 'Rain followed.', {
                  mode: 'agent',
                  model: 'gpt-fake',
                  costUsd: 0.0004,
                  proposalId: 'p-2'
                })
              ]
            })
          ]
        }
      })
    )
    expect(turns()[1]).toHaveTextContent(AGENT_NOTICE)
    expect(turns()[1]).not.toHaveTextContent('Rain followed.')
  })

  it('says AI is off and where to turn it on, with Send and the modes disabled (2026-10-07)', async () => {
    await mountOpen({ active: 'c-1', items: [conversation()] }, settings({ dial: 0 }))
    expect(screen.getByTestId('assistant-disabled')).toHaveTextContent(
      'AI is off for this project. Turn on Use AI in Settings › AI to use Ms Scribe.'
    )
    expect(AI_OFF_MESSAGE).toContain('Turn on Use AI in Settings › AI')
    for (const radio of within(screen.getByRole('radiogroup', { name: 'Mode' })).getAllByRole(
      'radio'
    )) {
      expect(radio).toBeDisabled()
    }
    await userEvent.type(box(), 'hello')
    expect(sendButton()).toBeDisabled()
    await userEvent.keyboard('{Enter}')
    expect(scribes).toHaveLength(0)
    act(() => useAiSettingsStore.setState({ settings: settings({ dial: 1 }) }))
    expect(screen.queryByTestId('assistant-disabled')).toBeNull()
    expect(sendButton()).toBeEnabled()
    act(() =>
      useAiSettingsStore.setState({
        settings: settings({ features: { ...defaultAiSettings().features, scribe: false } })
      })
    )
    expect(screen.getByTestId('assistant-disabled')).toHaveTextContent(
      'Ms Scribe with your notes and book is turned off for this project (Settings, AI tab).'
    )
    expect(sendButton()).toBeDisabled()
  })

  it('the Continuity view leads back to the conversation (F-13.4)', async () => {
    await mountOpen()
    act(() => useContinuityStore.getState().setViewOpen(true))
    await screen.findByTestId('continuity-panel')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }))
    expect(screen.queryByTestId('continuity-panel')).toBeNull()
    expect(useContinuityStore.getState().viewOpen).toBe(false)
    expect(tabs().map((t) => t.textContent)).toEqual(['Why the ridge?'])
  })

  it('New conversation adds a tab; closing one with messages confirms; the tablist has a roving tabindex', async () => {
    await mountOpen()
    await userEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(tabs().map((t) => t.textContent)).toEqual(['Why the ridge?', 'New conversation'])
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[0]).toHaveAttribute('tabindex', '-1')
    expect(tabs()[1]).toHaveAttribute('tabindex', '0')
    expect(turns()).toHaveLength(0)

    tabs()[1]?.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs()[0]).toHaveFocus()
    expect(turns()).toHaveLength(2)

    // Closing the empty tab needs no confirmation; closing the one with messages does.
    await userEvent.click(screen.getByRole('button', { name: 'Close New conversation' }))
    expect(modals()).toEqual([])
    expect(tabs()).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close Why the ridge?' }))
    expect(modals()).toEqual(['Close conversation'])
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(tabs().map((t) => t.textContent)).toEqual(['Why the ridge?'])
    await userEvent.click(screen.getByRole('button', { name: 'Close Why the ridge?' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    // The last tab is replaced by a fresh one.
    expect(tabs().map((t) => t.textContent)).toEqual(['New conversation'])
    expect(turns()).toHaveLength(0)
  })

  it('double-click or F2 renames a conversation tab inline; Escape cancels (2026-10-07)', async () => {
    await mountOpen()
    await userEvent.dblClick(tabs()[0]!)
    const input = screen.getByRole('textbox', { name: 'Rename conversation' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('Why the ridge?')
    await userEvent.keyboard('Ridge research{Enter}')
    expect(tabs().map((t) => t.textContent)).toEqual(['Ridge research'])
    expect(useAssistantStore.getState().conversations?.items[0]?.title).toBe('Ridge research')
    expect(tabs()[0]).toHaveFocus()
    await userEvent.keyboard('{F2}')
    await userEvent.keyboard('Nope{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Rename conversation' })).not.toBeInTheDocument()
    expect(tabs().map((t) => t.textContent)).toEqual(['Ridge research'])
  })

  it('has no actions in its header and no way to clear a conversation (2026-10-06)', async () => {
    await mountOpen()
    const header = screen.getByRole('heading', { name: 'Ms Scribe' }).parentElement!
    expect(within(header).queryByRole('button', { name: 'New conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'AI actions' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('continuity-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear conversation' })).not.toBeInTheDocument()
  })

  it('renders its chrome disabled before the conversations load', () => {
    install({ active: null, items: [] })
    useAiSettingsStore.setState({ settings: settings() })
    act(() => useLayoutStore.getState().toggle('assistant'))
    render(<Host />)
    expect(panel()).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(box()).toBeDisabled()
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled()
  })
})

describe('AssistantPanel Query mode (F-5.7)', () => {
  const CITATION = {
    nodeId: 'sc-1',
    title: 'Chapter 1 › Scene 1',
    scene: 1,
    quote: 'Rain followed it, and then the quiet held.'
  }
  const ANSWER = 'She waits out the storm [1] and crosses at dawn.'

  const queryTurn = (over: Partial<QueryTurn> = {}): QueryTurn => ({
    found: true,
    uncited: false,
    citations: [CITATION],
    sheets: [],
    also: [{ nodeId: 'sc-2', title: 'Chapter 2 › Scene 2' }],
    ...over
  })

  const answered = (
    answer: string,
    query: QueryTurn,
    mode: 'query' | 'plan' = 'query'
  ): Conversations => ({
    active: 'c-1',
    items: [
      conversation({
        mode: 'query',
        messages: [
          message('m-1', 'user', 'Where does she cross?'),
          message('m-2', 'assistant', answer, {
            mode,
            model: 'gpt-fake',
            costUsd: 0.0009,
            proposalId: 'p-2',
            query
          })
        ]
      })
    ]
  })

  it('a stored cited answer still opens its scene from its markers, sources, and Also mentioned in', async () => {
    await mountOpen(answered(ANSWER, queryTurn()))
    const openScene = spyOnOpenScene()
    const turn = turns()[1]!
    const marker = within(turn).getByTestId('query-cite')
    expect(marker).toHaveTextContent('[1]')
    await userEvent.click(marker)
    expect(openScene).toHaveBeenCalledExactlyOnceWith(CITATION, CITATION.quote)
    await userEvent.click(within(turn).getByTestId('query-citation'))
    expect(openScene).toHaveBeenCalledTimes(2)
    await userEvent.click(within(turn).getByTestId('query-also'))
    expect(openScene).toHaveBeenLastCalledWith(
      { nodeId: 'sc-2', title: 'Chapter 2 › Scene 2' },
      null
    )
  })

  // No store reset restores an action, and the workers share modules across files: left in
  // place, the spy below is the `openScene` every later test file in this worker calls.
  const realOpenScene = useAssistantStore.getState().openScene
  afterEach(() => {
    useAssistantStore.setState({ openScene: realOpenScene })
  })

  /** Replaces `openScene` with a spy: the panel's buttons are what this describe checks. */
  function spyOnOpenScene(): ReturnType<typeof vi.fn> {
    const openScene = vi.fn(async () => {})
    act(() => useAssistantStore.setState({ openScene }))
    return openScene
  }

  it('sends a question to Ms Scribe, shows her lookups live, then the answer with its sources and cost (notes redesign phase 1)', async () => {
    routeAction = 'query'
    await mountOpen({ active: 'c-1', items: [conversation({ messages: [] })] })
    const openScene = spyOnOpenScene()
    await userEvent.type(box(), 'Where does she cross?{Enter}')
    expect(scribes).toHaveLength(1)
    expect(scribes[0]?.input).toMatchObject({
      message: 'Where does she cross?',
      nodeId: null,
      mode: 'write'
    })
    expect(within(turns()[1]!).getByTestId('chat-pending')).toBeInTheDocument()
    act(() =>
      useAssistantStore.setState({
        agentSteps: {
          [scribes[0]?.input.requestId ?? '']: [
            { tool: 'search_book', label: 'Searching “crossing”…' }
          ]
        }
      })
    )
    expect(within(turns()[1]!).getByTestId('agent-step')).toHaveTextContent('Searching “crossing”…')

    await act(async () => {
      const request = scribes[0]
      request?.resolve(
        scribeOk(request.input.requestId, 'She crosses at dawn in Chapter 1 › Scene 1.', {
          cached: false,
          usage: { inputTokens: 900, outputTokens: 60 },
          costUsd: 0.0009,
          steps: [{ tool: 'search_book', label: 'Searching “crossing”…' }],
          sources: {
            scenes: [
              {
                nodeId: 'sc-1',
                title: 'Chapter 1 › Scene 1',
                quotes: ['She crossed at dawn', 'The river was high']
              },
              { nodeId: 'sc-2', title: 'Chapter 1 › Scene 2', quotes: [] }
            ],
            pages: [{ id: 'pg-river', title: 'The river', kind: 'note', quotes: ['Wide and slow'] }]
          }
        })
      )
    })
    const turn = turns()[1]!
    expect(turn).toHaveTextContent('She crosses at dawn in Chapter 1 › Scene 1.')
    expect(within(turn).getByTestId('chat-turn-cost')).toHaveTextContent(
      'gpt-fake · $0.0009 · 900 in · 60 out'
    )
    const [scene, plain] = within(turn).getAllByTestId('scribe-source-scene')
    expect(scene).toHaveTextContent('Chapter 1 › Scene 1')
    // A source opens at the first passage she relied on; each further one has its own link.
    expect(scene).toHaveAttribute('title', 'Open Chapter 1 › Scene 1 at “She crossed at dawn”')
    await userEvent.click(scene!)
    expect(openScene).toHaveBeenCalledExactlyOnceWith(
      { nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' },
      'She crossed at dawn'
    )
    await userEvent.click(
      within(turn).getByRole('button', { name: 'Open Chapter 1 › Scene 1 at passage 2' })
    )
    expect(openScene).toHaveBeenLastCalledWith(
      { nodeId: 'sc-1', title: 'Chapter 1 › Scene 1' },
      'The river was high'
    )
    expect(within(turn).getAllByTestId('scribe-source-passage')).toHaveLength(1)
    // A source with no passage opens the scene as it is.
    await userEvent.click(plain!)
    expect(openScene).toHaveBeenLastCalledWith(
      { nodeId: 'sc-2', title: 'Chapter 1 › Scene 2' },
      null
    )
    const page = within(turn).getByTestId('scribe-source-page')
    expect(page).toHaveTextContent('The river')
    await userEvent.click(page)
    expect(useOpenNotebookPageStore.getState().openNotebookPageId).toBe('pg-river')
    expect(useOpenNotebookPageStore.getState().quote).toBe('Wide and slow')
  })

  it('says so when the scenes do not answer, and flags an answer no citation survived', async () => {
    await mountOpen(
      answered(
        `${QUERY_NOT_FOUND} No scene names the boat's owner.`,
        queryTurn({ found: false, citations: [], also: [] })
      )
    )
    const notFound = turns()[1]!
    expect(within(notFound).getByTestId('query-not-found')).toHaveTextContent(QUERY_NOT_FOUND)
    expect(within(notFound).queryByTestId('query-citation')).not.toBeInTheDocument()
    expect(within(notFound).queryByTestId('query-also')).not.toBeInTheDocument()

    act(() =>
      useAssistantStore.setState({
        conversations: answered('She crosses at dawn.', queryTurn({ uncited: true, citations: [] }))
      })
    )
    const uncited = turns()[1]!
    expect(within(uncited).getByTestId('query-uncited')).toHaveTextContent(
      'No cited passage supports this answer; treat it as unverified.'
    )
    expect(within(uncited).queryByTestId('query-citation')).not.toBeInTheDocument()
    expect(within(uncited).getByTestId('query-also')).toHaveTextContent('Chapter 2 › Scene 2')
  })

  it('shows no unverified warning on a Plan chat answer with no citation (brainstorming, 2026-10-10)', async () => {
    await mountOpen(
      answered(
        'She could cross at dawn, or wait for the ferry.',
        queryTurn({ uncited: true, citations: [] }),
        'plan'
      )
    )
    const turn = turns()[1]!
    expect(turn).toHaveTextContent('She could cross at dawn, or wait for the ferry.')
    expect(within(turn).queryByTestId('query-uncited')).not.toBeInTheDocument()
  })

  it("lists the author's sheets an answer rests on, and a click opens the entity's page", async () => {
    resetEntityStore()
    await mountOpen(
      answered(
        'She has grey eyes.',
        queryTurn({
          citations: [],
          also: [],
          sheets: [{ entityId: 'e-mara', name: 'Mara', kind: 'character' }]
        })
      )
    )
    const turn = turns()[1]!
    expect(within(turn).queryByTestId('query-uncited')).not.toBeInTheDocument()
    expect(within(turn).getByText('From your notes')).toBeInTheDocument()
    const sheet = within(turn).getByTestId('query-sheet')
    expect(sheet).toHaveTextContent('Mara')
    await userEvent.click(sheet)
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    resetEntityStore()
  })

  it('leaves a marker naming no surviving citation as plain text', async () => {
    await mountOpen(answered('She crosses [1] at dawn [4].', queryTurn({ also: [] })))
    const turn = turns()[1]!
    expect(within(turn).getAllByTestId('query-cite')).toHaveLength(1)
    expect(turn).toHaveTextContent('She crosses [1] at dawn [4].')
  })
})

describe('AssistantPanel agent edits (F-5.22)', () => {
  const TEXT_EDIT = {
    kind: 'text',
    nodeId: 'sc-1',
    title: 'Chapter 1 › Scene 1',
    find: 'Mara climbed the ridge alone.',
    replace: 'Mara went up the ridge alone.',
    brief: ''
  } as const
  const DELETE = { kind: 'delete', target: 'node', id: 'sc-2', name: 'Scene 2' } as const

  const withChanges = (changes: AgentChange[]): Conversations => ({
    active: 'c-1',
    items: [
      conversation({
        messages: [
          message('m-1', 'user', 'Tighten the ridge line.'),
          message('m-2', 'assistant', 'Here is a tighter line.', {
            mode: 'plan',
            model: 'gpt-fake',
            costUsd: 0.002,
            proposalId: 'p-2',
            agent: {
              access: 'write',
              steps: [{ tool: 'read_scene', label: 'Reading Chapter 1 › Scene 1…' }],
              changes
            }
          })
        ]
      })
    ]
  })

  const change = (
    id: string,
    edit: AgentChange['edit'],
    over: Partial<AgentChange> = {}
  ): AgentChange => ({
    id,
    edit,
    status: 'pending',
    violation: null,
    error: null,
    proposalId: null,
    notice: null,
    ...over
  })

  it('shows a pending edit with the removed text struck and the added text marked, Apply and Skip, and a deletion that says so', async () => {
    await mountOpen(withChanges([change('e-1', TEXT_EDIT), change('e-2', DELETE)]))
    const turn = turns()[1]!
    expect(within(turn).getByText('Looked up one thing')).toBeInTheDocument()
    const cards = within(turn).getAllByTestId('agent-change')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('Changed Chapter 1 › Scene 1')
    const diff = within(cards[0]!).getByTestId('agent-change-diff')
    expect(diff.querySelector('del')).toHaveTextContent('climbed')
    expect(diff.querySelector('ins')).toHaveTextContent('went')
    expect(within(cards[0]!).getByTestId('agent-change-apply')).toHaveTextContent('Apply')
    expect(cards[1]).toHaveTextContent('Delete Scene 2')
    expect(cards[1]).toHaveTextContent('This deletes; it always asks first, even in Auto.')
    expect(within(cards[1]!).getByTestId('agent-change-apply')).toHaveTextContent('Delete')
    // One waiting edit besides the deletion: no Apply all.
    expect(within(turn).queryByTestId('agent-apply-all')).not.toBeInTheDocument()

    await userEvent.click(within(cards[1]!).getByTestId('agent-change-skip'))
    const skipped = within(turns()[1]!).getAllByTestId('agent-change')[1]!
    expect(skipped).toHaveAttribute('data-status', 'skipped')
    expect(skipped).toHaveTextContent('Skipped: Delete Scene 2')
  })

  it('logs applied and failed edits as lines, offers Apply all for two waiting, and flags an off-voice one', async () => {
    await mountOpen(
      withChanges([
        change('e-1', TEXT_EDIT, { status: 'applied' }),
        change(
          'e-2',
          { ...TEXT_EDIT, find: 'Nobody followed.' },
          { status: 'failed', error: 'The passage is no longer in the scene' }
        ),
        change('e-3', { kind: 'rename', nodeId: 'sc-1', title: 'Scene 1', after: 'The ridge' }),
        change(
          'e-4',
          { kind: 'synopsis', nodeId: 'sc-1', title: 'Scene 1', before: '', after: 'Mara climbs.' },
          { violation: 'uses a banned phrase' }
        )
      ])
    )
    const cards = within(turns()[1]!).getAllByTestId('agent-change')
    expect(cards[0]).toHaveTextContent(
      'Changed Chapter 1 › Scene 1: “Mara went up the ridge alone.”'
    )
    // The undo lives in memory: a turn from another session offers none.
    expect(within(cards[0]!).queryByTestId('agent-change-undo')).not.toBeInTheDocument()
    expect(cards[1]).toHaveTextContent(
      'Could not apply: Changed Chapter 1 › Scene 1 (The passage is no longer in the scene)'
    )
    expect(within(cards[3]!).getByTestId('agent-change-flag')).toHaveTextContent(
      'uses a banned phrase'
    )
    expect(within(turns()[1]!).getByTestId('agent-apply-all')).toBeInTheDocument()
  })

  /** One line of a clear card: the items it covers, by id. */
  const line = (
    group: ClearOption['group'],
    id: string,
    label: string,
    ids: string[],
    checked: boolean
  ): ClearOption => ({ group, id, label, count: ids.length, ids, checked })

  it('F-5.25: a clear asks with a checkbox per kind, pre-ticked; unticking changes what Delete removes', async () => {
    const CLEAR = {
      kind: 'clear',
      options: [
        line('sheets', 'character', 'Characters', ['mara', 'tomas'], true),
        line('sheets', 'setting', 'Places', ['elm'], true),
        line('tags', 'tone', 'Tone', ['dread', 'calm', 'storm'], true),
        line('library', 'library', 'Library uploads', ['up-1'], true),
        line(
          'notes',
          'notes',
          'Notes on scenes and chapters',
          ['sc-1', 'sc-2', 'sc-3', 'sc-4'],
          false
        )
      ]
    } satisfies AgentChange['edit']
    await mountOpen(withChanges([change('e-1', CLEAR)]))
    const card = within(turns()[1]!).getByTestId('agent-change')
    expect(card).toHaveTextContent('Are these the things you want to delete?')
    expect(card).toHaveTextContent('A backup is taken first, and Undo puts everything back.')
    const boxes = within(card).getAllByTestId('agent-clear-option')
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([
      true,
      true,
      true,
      true,
      false
    ])
    const apply = within(card).getByTestId('agent-change-apply')
    expect(apply).toHaveTextContent('Delete 3 sheets, 3 tags, 1 upload')

    // The author keeps the places and the uploads.
    await userEvent.click(within(card).getByRole('checkbox', { name: 'Places (1)' }))
    await userEvent.click(within(card).getByRole('checkbox', { name: 'Library uploads (1)' }))
    expect(within(turns()[1]!).getByTestId('agent-change-apply')).toHaveTextContent(
      'Delete 2 sheets, 3 tags'
    )
    // Kept on the turn (which is saved), so a reload shows the card as left.
    const stored =
      useAssistantStore.getState().conversations?.items[0]?.messages[1]?.agent?.changes[0]?.edit
    expect(stored?.kind === 'clear' ? stored.options.map((o) => o.checked) : null).toEqual([
      true,
      false,
      true,
      false,
      false
    ])

    await userEvent.click(within(turns()[1]!).getByTestId('agent-change-apply'))
    expect(clears).toEqual([
      {
        // Exactly the items the card listed, by id.
        selection: {
          sheets: ['mara', 'tomas'],
          tags: ['dread', 'calm', 'storm'],
          library: [],
          notes: []
        },
        run: 'm-2'
      }
    ])
    const done = within(turns()[1]!).getByTestId('agent-change')
    expect(done).toHaveAttribute('data-status', 'applied')
    expect(within(done).getByTestId('agent-change-undo')).toBeInTheDocument()
  })

  it('F-5.25: Delete waits for at least one tick, and a clear is never part of Apply all', async () => {
    await mountOpen(
      withChanges([
        change('e-1', {
          kind: 'clear',
          options: [line('tags', 'tone', 'Tone', ['dread', 'calm', 'storm'], false)]
        }),
        change('e-2', TEXT_EDIT),
        change('e-3', { ...TEXT_EDIT, find: 'Nobody followed.' })
      ])
    )
    const cards = within(turns()[1]!).getAllByTestId('agent-change')
    expect(within(cards[0]!).getByTestId('agent-change-apply')).toBeDisabled()
    expect(within(turns()[1]!).getByTestId('agent-apply-all')).toBeInTheDocument()
    await userEvent.click(within(cards[0]!).getByTestId('agent-change-skip'))
    expect(within(turns()[1]!).getAllByTestId('agent-change')[0]).toHaveTextContent(
      'Skipped: Delete nothing from the story bible'
    )
    expect(clears).toEqual([])
  })
})

describe('AssistantPanel quick actions (F-5.17)', () => {
  const DIRECTIONS = [
    { title: 'The storm breaks', text: 'Rain drives them into the shepherd hut.' },
    { title: 'A light below', text: 'Someone is camped in the valley.' }
  ]
  const withDirections = (directions = DIRECTIONS): Conversations => ({
    active: 'c-1',
    items: [
      conversation({
        messages: [
          message('m-1', 'user', 'What should come next?'),
          message('m-2', 'assistant', '1. The storm breaks: …', {
            mode: 'plan',
            model: 'gpt-fast',
            costUsd: 0.0004,
            proposalId: 'p-3',
            directions
          })
        ]
      })
    ]
  })
  const writes = (): HTMLElement[] => screen.getAllByTestId('what-next-write')

  let editor: Editor
  beforeEach(() => {
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' })
    })
  })
  afterEach(() => {
    resetActiveEditorStore()
    editor.destroy()
  })

  it('renders a turn’s directions as cards, and Write this sends one to the agent with its edit tools', async () => {
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    await mountOpen(withDirections())
    const cards = within(log()).getAllByTestId('what-next-direction')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('The storm breaks')
    expect(cards[0]).toHaveTextContent('Rain drives them into the shepherd hut.')
    expect(turns()[1]).toHaveTextContent('gpt-fast')
    expect(writes()[1]).toBeEnabled()
    await userEvent.click(writes()[1]!)
    expect(queries[0]?.input).toMatchObject({
      access: 'write',
      nodeId: 'sc-1',
      message:
        'Continue the scene in this direction: A light below. Someone is camped in the valley.'
    })
    // While the turn waits, Write this waits too.
    expect(writes()[0]).toBeDisabled()
    expect(writes()[0]).toHaveAttribute('title', CONVERSATION_BUSY_MESSAGE)
  })

  it('Write this is off with the reason while AI is off, with lookups and edits off, in Plan, or without an editor', async () => {
    await mountOpen(withDirections(), settings({ dial: 0 }))
    expect(writes()[0]).toBeDisabled()
    expect(writes()[0]).toHaveAttribute(
      'title',
      'Write this needs Use AI turned on, with Ms Scribe lookups and edits on (Settings, AI tab)'
    )
    const on = settings()
    act(() =>
      useAiSettingsStore.setState({
        settings: { ...on, features: { ...on.features, agent: false } }
      })
    )
    expect(writes()[0]?.getAttribute('title')).toContain('with Ms Scribe lookups and edits on')
    act(() => useAiSettingsStore.setState({ settings: { ...on, chatMode: 'brainstorm' } }))
    expect(writes()[0]).toHaveAttribute('title', PLAN_NO_EDITS_MESSAGE)
    act(() => useAiSettingsStore.setState({ settings: on }))
    expect(writes()[0]).toHaveAttribute('title', NO_SCENE_MESSAGE)
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    expect(writes()[0]).toBeEnabled()
  })

  it('says so when no direction came back', async () => {
    await mountOpen(withDirections([]))
    expect(within(log()).getByText(NO_DIRECTIONS_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByTestId('what-next-direction')).not.toBeInTheDocument()
  })
})

describe('AssistantPanel suggestions (2026-10-06)', () => {
  const suggestion = (): HTMLElement => screen.getByTestId('assistant-suggestion')
  const auto = (): Conversations => ({
    active: 'c-1',
    items: [conversation({ messages: [] })]
  })
  const rotate = (): void => {
    act(() => {
      vi.advanceTimersByTime(SUGGESTION_ROTATE_MS)
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
  }

  let editor: Editor
  beforeEach(() => {
    resetEntityStore()
    useTreeStore.getState().clear()
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' })
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    resetActiveEditorStore()
    resetEntityStore()
    useTreeStore.getState().clear()
    editor.destroy()
  })

  it('shows one suggestion above the box; a click fills the box and sends nothing', async () => {
    await mountOpen(auto())
    const text = suggestion().textContent ?? ''
    expect([
      'Who are the main characters so far?',
      'What is still unresolved in the story?',
      'Talk me through where the story goes'
    ]).toContain(text)
    await userEvent.click(suggestion())
    expect(box()).toHaveValue(text)
    expect(box()).toHaveFocus()
    expect(queries).toHaveLength(0)
  })

  it('fits the mode, and shows none while AI is off', async () => {
    await mountOpen(
      { active: 'c-1', items: [conversation({ messages: [] })] },
      settings({ chatMode: 'brainstorm' })
    )
    expect([
      'Who are the main characters so far?',
      'What is still unresolved in the story?',
      'Talk me through where the story goes'
    ]).toContain(suggestion().textContent)
    act(() => useAiSettingsStore.setState({ settings: settings({ dial: 0 }) }))
    expect(screen.queryByTestId('assistant-suggestion')).not.toBeInTheDocument()
  })

  it('rotates on a timer, and holds still while the box has text', async () => {
    vi.useFakeTimers()
    await mountOpen(auto())
    const first = suggestion().textContent
    rotate()
    const second = suggestion().textContent
    expect(second).not.toBe(first)
    fireEvent.change(box(), { target: { value: 'Where' } })
    rotate()
    rotate()
    expect(suggestion().textContent).toBe(second)
  })

  it("names the story bible's characters and offers the scene actions for an open scene", async () => {
    const mara = entityFixture.find((e) => e.kind === 'character')!
    useEntityStore.setState({ byId: { [mara.id]: mara }, ids: [mara.id] })
    useTreeStore.setState({ ...buildIndex(continuityTree), loaded: true })
    editor.commands.setContent(`<p>${'Mara climbed the ridge in the rain. '.repeat(10)}</p>`)
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    vi.useFakeTimers()
    await mountOpen(auto())
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) {
      seen.add(suggestion().textContent ?? '')
      rotate()
    }
    expect(seen).toContain('Proofread this scene')
    expect(seen).toContain('What happens next here?')
    expect([...seen].some((text) => text.includes(mara.name))).toBe(true)
  })
})

describe('AssistantPanel edit requests (F-5.26)', () => {
  const ASK: EditTurn = {
    target: { kind: 'scene', nodeIds: ['sc-1'], title: 'Scene 1', excerpt: null },
    choices: ['line', 'developmental', 'dialogue', 'proofread', 'critique'],
    instruction: null,
    picked: null,
    passId: null
  }
  const withEdit = (edit: EditTurn = ASK, content = EDIT_ASK_QUESTION): Conversations => ({
    active: 'c-1',
    items: [
      conversation({
        messages: [
          message('m-1', 'user', 'Make this scene better'),
          message('m-2', 'assistant', content, {
            action: 'editPass',
            model: 'gpt-fast',
            costUsd: 0.00006,
            edit
          })
        ]
      })
    ]
  })
  const choices = (): HTMLElement[] => within(log()).getAllByTestId('edit-choice')
  const choice = (id: string): HTMLElement =>
    choices().find((el) => el.dataset.choice === id) ?? document.body

  let editor: Editor
  beforeEach(() => {
    resetEditPassStore()
    resetAccountStore()
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' })
    })
  })
  afterEach(() => {
    resetEditPassStore()
    resetAccountStore()
    resetActiveEditorStore()
    useTreeStore.getState().clear()
    editor.destroy()
  })

  it('asks with the quick picks, each with what it would cost, and a pick starts its pass', async () => {
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    await mountOpen(withEdit())
    expect(turns()[1]).toHaveTextContent(EDIT_ASK_QUESTION)
    expect(choices().map((el) => el.querySelector('span')?.textContent)).toEqual([
      'Tighten prose',
      'Pacing & structure',
      'Dialogue',
      'Proofread',
      "Editor's notes"
    ])
    // Scene 1 has 1,200 words: a pass shows its estimate; Editor's notes is not a pass.
    expect(choice('line')).toHaveTextContent(/about \$/)
    expect(choice('line').getAttribute('title')).toMatch(/^With MythScribe: about \$/)
    expect(choice('critique')).not.toHaveTextContent('$')
    await userEvent.click(choice('line'))
    expect(passStarts).toEqual([
      { type: 'line', instruction: null, nodeIds: ['sc-1'], excerpt: null }
    ])
    const status = await within(log()).findByTestId('edit-request-status')
    expect(status).toHaveAttribute('data-status', 'running')
    expect(status).toHaveTextContent('Line edit: 0 of 1 scene read.')
    expect(within(log()).queryAllByTestId('edit-choice')).toHaveLength(0)
  })

  it('the picks are off with the reason in Plan, while the turn waits, and while a pass runs', async () => {
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    await mountOpen(withEdit(), settings({ chatMode: 'brainstorm' }))
    expect(choice('line')).toBeDisabled()
    expect(choice('line')).toHaveAttribute('title', PLAN_NO_EDITS_MESSAGE)
    act(() => useAiSettingsStore.setState({ settings: settings() }))
    expect(choice('line')).toBeEnabled()
    act(() =>
      useEditPassStore.setState({
        byId: { other: editPassSummary({ id: 'other' }) },
        ids: ['other']
      })
    )
    expect(choice('line')).toBeDisabled()
    expect(choice('line')).toHaveAttribute(
      'title',
      'An edit pass is already running. Stop it or wait for it to finish.'
    )
    // Editor's notes is not a pass: a running pass does not hold it, the scene's length does.
    expect(choice('critique')).toHaveAttribute('title', 'Write 200 characters first')
  })

  it('on MythScribe Cloud a quote over the threshold asks once more before it starts', async () => {
    act(() => useActiveEditorStore.getState().set('sc-1', editor))
    act(() =>
      useAccountStore.setState({ pricing: { ...bundledPricing(), quoteThresholdMicros: 0 } })
    )
    await mountOpen(withEdit(), settings({ source: 'cloud' }))
    expect(choice('proofread')).toHaveTextContent(/up to about <?\$/)
    await userEvent.click(choice('proofread'))
    expect(passStarts).toHaveLength(0)
    expect(within(log()).getByTestId('edit-choice-quote')).toHaveTextContent(
      /^This pass takes up to about <?\$.* from your MythScribe Cloud balance/
    )
    await userEvent.click(within(log()).getByTestId('edit-choice-confirm'))
    expect(passStarts).toEqual([
      { type: 'proofread', instruction: null, nodeIds: ['sc-1'], excerpt: null }
    ])
  })

  it('a finished pass offers its review deck over the tracked changes', async () => {
    act(() =>
      useEditPassStore.setState({
        byId: {
          'pass-1': editPassSummary({
            status: 'done',
            doneNodeIds: ['sc-1'],
            counts: { pending: 1, accepted: 0, rejected: 0, stale: 0 }
          })
        },
        ids: ['pass-1']
      })
    )
    await mountOpen(withEdit({ ...ASK, picked: 'line', passId: 'pass-1' }, 'Line edit started.'))
    expect(within(log()).getByTestId('edit-request-status')).toHaveTextContent(
      'Line edit finished: 1 change to review.'
    )
    await userEvent.click(within(log()).getByTestId('edit-request-review'))
    await expect.poll(() => useEditPassStore.getState().review?.currentId).toBe('ec-1')
  })
})

describe('AssistantPanel Ms Scribe turns (F-16.24, F-16.25; story memory v2)', () => {
  const SCRIBE: ScribeTurn = {
    turn: 'answer',
    citations: [
      {
        n: 1,
        evidence: 'E2',
        label: 'idea',
        ref: 'Mara’s Ideas ¶0',
        title: 'Mara',
        open: null,
        quote: 'Maybe Mara has a twin',
        checked: 'cite',
        doc: null
      }
    ],
    notChecked: [],
    unsupported: [],
    scope: 'Searched every scene up to 1.1 for twin',
    notFound: false,
    retried: false,
    widened: null,
    misses: 0,
    checkUsd: 0.0001
  }
  const CARD: InstantCardData = {
    kind: 'slot',
    recordId: 'r-mara',
    name: 'Mara',
    slot: 'eyes',
    label: 'Eyes',
    value: 'grey',
    claimId: 'c-eyes',
    quote: "Mara's eyes were grey",
    ref: '1.1',
    nodeId: 'sc-1',
    para: 1,
    since: null,
    lastStated: false,
    asOfRef: '1.1',
    readFirst: null
  }
  const QUERY: QueryTurn = {
    found: true,
    uncited: false,
    citations: [{ nodeId: 'sc-1', title: 'Chapter 1 › Scene 1', scene: 1, quote: 'The rain.' }],
    sheets: [],
    also: []
  }

  it('draws an instant card, a cited v2 answer with its cost parts, and a v1 answer as before', async () => {
    await mountOpen({
      active: 'c-1',
      items: [
        conversation({
          messages: [
            message('m-1', 'user', "Mara's eyes?"),
            message('m-2', 'assistant', 'Mara · Eyes: grey (1.1)', {
              action: 'query',
              mode: 'query',
              card: CARD
            }),
            message('m-3', 'user', 'What was my idea about her twin?'),
            message('m-4', 'assistant', 'Your idea: a twin in the north.[1]', {
              mode: 'plan',
              model: 'deepseek/deepseek-v4-pro',
              costUsd: 0.0145,
              usage: { inputTokens: 9_000, outputTokens: 300 },
              proposalId: 'p-4',
              scribe: SCRIBE,
              agent: {
                access: 'read',
                steps: [
                  { tool: 'search', label: "Searching 'twin'…" },
                  { tool: 'ideas', label: 'Reading your ideas for Mara…' },
                  { tool: 'check', label: 'Checking the quotes…' }
                ],
                changes: []
              },
              costParts: [
                { part: 'navigator', costUsd: 0.0018 },
                { part: 'answer', costUsd: 0.0126 },
                { part: 'check', costUsd: 0.0001 }
              ]
            }),
            message('m-5', 'user', 'Where does she cross?'),
            message('m-6', 'assistant', 'At dawn [1].', {
              mode: 'query',
              model: 'gpt-fake',
              costUsd: 0.0009,
              proposalId: 'p-6',
              query: QUERY
            })
          ]
        })
      ]
    })
    const [, card, , scribe, , v1] = turns()
    // The instant card: drawn from the turn's card, with its mark and no cost line (no request).
    expect(within(card!).getByTestId('instant-card')).toHaveTextContent('Eyes: grey (1.1)')
    expect(within(card!).getByTestId('instant-card-label')).toHaveTextContent(
      'Read by AI from your book · quote checked · no AI call now'
    )
    expect(within(card!).queryByTestId('chat-turn-cost')).toBeNull()
    // Ms Scribe's answer: its chip and source, never QueryAnswer's markers.
    const answer = within(scribe!)
    expect(answer.getByTestId('scribe-cite')).toHaveTextContent('[1]')
    expect(answer.getByTestId('scribe-source-label')).toHaveTextContent(
      'your idea, not in the book'
    )
    expect(answer.getByTestId('scribe-scope')).toHaveTextContent('Searched every scene up to 1.1')
    expect(answer.queryByTestId('query-cite')).toBeNull()
    expect(answer.getByTestId('request-cost-parts')).toHaveAttribute(
      'title',
      'navigator 0.2¢ · answer 1.3¢ · check 0.01¢'
    )
    expect(answer.getByTestId('chat-turn-cost')).toHaveTextContent('$0.0145')
    // The navigator's lookups and the answer's quote check, folded once the answer is in.
    expect(answer.getByText('Looked up 2 things · checked the quotes')).toBeInTheDocument()
    expect(answer.getAllByTestId('agent-step').map((step) => step.textContent)).toEqual([
      "Searching 'twin'…",
      'Reading your ideas for Mara…',
      'Checking the quotes…'
    ])
    // A v1 turn keeps QueryAnswer, with no parts title.
    const old = within(v1!)
    expect(old.getByTestId('query-cite')).toHaveTextContent('[1]')
    expect(old.queryByTestId('scribe-answer')).toBeNull()
    expect(old.queryByTestId('request-cost-parts')).toBeNull()
  })
})
