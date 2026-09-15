import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Conversation, Conversations } from '@shared/chat'
import type { AiChatResult, Channel, Input, Output } from '@shared/ipc/contract'
import { LAYOUT_LIMITS, defaultLayout } from '@shared/layout'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiSettingsStore, useAiSettingsStore } from './aiSettingsStore'
import { AssistantPanel, AssistantToggleButton } from './AssistantPanel'
import { AGENT_NOTICE, resetAssistantStore, useAssistantStore } from './assistantStore'
import { resetProposalStore } from './proposalStore'

interface PendingChat {
  input: Input<'ai:chat'>
  resolve: (result: AiChatResult) => void
}

let chats: PendingChat[]
let sets: Conversations[]

/** `conversations:get` answers with `stored`; writes record; `ai:chat` resolves when the test says so. */
function install(stored: Conversations): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'conversations:get') return stored as Output<C>
      if (channel === 'conversations:set') {
        sets.push(input as Input<'conversations:set'>)
        return input as Output<C>
      }
      if (channel === 'ai:chat') {
        return new Promise<Output<C>>((resolve) => {
          chats.push({
            input: input as Input<'ai:chat'>,
            resolve: (result) => resolve(result as Output<C>)
          })
        })
      }
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'proposal:settle') return null as Output<C>
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
  mode: null,
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
  dial: 2,
  ...over
})

const ok = (requestId: string, text: string): AiChatResult => ({
  ok: true,
  text,
  usage: { inputTokens: 200, outputTokens: 40 },
  costUsd: 0.0003,
  cached: true,
  model: 'gpt-fake',
  flagged: false,
  violation: null,
  proposalId: `prop-${requestId}`,
  requestId
})

const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Assistant' })
const log = (): HTMLElement => screen.getByRole('log', { name: 'Messages' })
const tabs = (): HTMLElement[] =>
  within(screen.getByRole('tablist', { name: 'Conversations' })).getAllByRole('tab')
const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' })
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' })
const turns = (): HTMLElement[] => within(log()).queryAllByTestId('chat-turn')
const modals = (): string[] => useDialogStore.getState().modals.map((m) => m.options.title)

function Host(): React.JSX.Element {
  return (
    <div>
      <AssistantToggleButton />
      <div className="flex">
        <div>editor</div>
        <AssistantPanel />
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
  chats = []
  sets = []
  resetLayoutStore()
  resetAssistantStore()
  resetAiSettingsStore()
  resetActiveEditorStore()
  resetProposalStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetLayoutStore()
  resetAssistantStore()
  resetAiSettingsStore()
  vi.unstubAllGlobals()
})

describe('AssistantPanel (F-5.4)', () => {
  it('starts closed; the header button and Ctrl+K toggle it and report aria-pressed', async () => {
    install({ active: null, items: [] })
    render(<Host />)
    const button = screen.getByRole('button', { name: 'Assistant' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()

    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(panel()).toBeInTheDocument()
    expect(panel().style.width).toBe(`${defaultLayout().assistant.size * 100}vw`)
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeInTheDocument()

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument()
    await userEvent.keyboard('{Control>}k{/Control}')
    expect(panel()).toBeInTheDocument()
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
  })

  it('resizes by its left-edge handle with the arrow keys, clamped to its limits', async () => {
    await mountOpen()
    const handle = within(panel()).getByRole('separator', { name: 'Resize assistant' })
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
    expect(within(theirs!).getByTestId('chat-turn-cost')).toHaveTextContent('gpt-fake · $0.0002')
    expect(within(mine!).queryByTestId('chat-turn-cost')).not.toBeInTheDocument()
    const modes = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(within(modes).getByRole('radio', { name: 'Plan' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(modes).getByRole('radio', { name: 'Agent' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.queryByRole('combobox', { name: 'Paragraphs' })).not.toBeInTheDocument()
    expect(box()).toBeEnabled()
    expect(sendButton()).toBeDisabled()
    expect(screen.queryByTestId('assistant-disabled')).not.toBeInTheDocument()
  })

  it('Enter sends, Shift+Enter breaks the line, and the answer streams into the log with its cost', async () => {
    await mountOpen()
    await userEvent.type(box(), 'What next{Shift>}{Enter}{/Shift}for Mara?')
    expect(box()).toHaveValue('What next\nfor Mara?')
    expect(sendButton()).toBeEnabled()
    await userEvent.keyboard('{Enter}')
    expect(chats).toHaveLength(1)
    expect(chats[0]?.input).toMatchObject({
      message: 'What next\nfor Mara?',
      mode: 'plan',
      nodeId: null
    })
    expect(box()).toHaveValue('')
    expect(turns()).toHaveLength(4)
    expect(within(turns()[3]!).getByTestId('chat-pending')).toHaveTextContent('Thinking…')
    expect(sendButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeDisabled()

    await act(async () => {
      chats[0]?.resolve(ok(chats[0].input.requestId, 'She climbs.'))
    })
    expect(turns()[3]).toHaveTextContent('She climbs.')
    expect(within(turns()[3]!).getByTestId('chat-turn-cost')).toHaveTextContent(
      'gpt-fake · $0.0003 · cached'
    )
    expect(screen.queryByTestId('chat-pending')).not.toBeInTheDocument()
    await userEvent.type(box(), 'more')
    expect(sendButton()).toBeEnabled()
  })

  it('Agent is disabled below Suggest with the reason; at Suggest it shows the paragraph selector and the notice turn', async () => {
    await mountOpen({ active: 'c-1', items: [conversation()] }, settings({ dial: 1 }))
    const agent = screen.getByRole('radio', { name: 'Agent' })
    expect(agent).toBeDisabled()
    expect(agent).toHaveAttribute(
      'title',
      'Agent needs the AI dial at Suggest or higher (Settings, AI tab)'
    )
    act(() => useAiSettingsStore.setState({ settings: settings({ dial: 2 }) }))
    expect(agent).toBeEnabled()
    await userEvent.click(agent)
    expect(agent).toHaveAttribute('aria-checked', 'true')
    expect(useAssistantStore.getState().conversations?.items[0]?.mode).toBe('agent')
    const paragraphs = screen.getByRole('combobox', { name: 'Paragraphs' })
    expect(paragraphs).toHaveValue('1')
    expect(within(paragraphs).getAllByRole('option')).toHaveLength(10)
    await userEvent.selectOptions(paragraphs, '4')
    expect(useAssistantStore.getState().conversations?.items[0]?.paragraphs).toBe(4)
    // Arrow keys move between the modes on the radios themselves.
    agent.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Plan' })).toHaveFocus()

    // An Agent turn already recorded reads as the notice, never as its text.
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

  it('says what to change and disables Send while the dial does not allow the assistant', async () => {
    await mountOpen({ active: 'c-1', items: [conversation()] }, settings({ dial: 0 }))
    expect(screen.getByTestId('assistant-disabled')).toHaveTextContent(
      'The assistant needs the AI dial at Ask or higher'
    )
    await userEvent.type(box(), 'hello')
    expect(sendButton()).toBeDisabled()
    await userEvent.keyboard('{Enter}')
    expect(chats).toHaveLength(0)
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

  it('Clear conversation confirms, then empties the log', async () => {
    await mountOpen()
    await userEvent.click(screen.getByRole('button', { name: 'Clear conversation' }))
    expect(modals()).toEqual(['Clear conversation'])
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(turns()).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Clear conversation' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(within(log()).queryAllByTestId('chat-turn')).toHaveLength(0)
    expect(tabs().map((t) => t.textContent)).toEqual(['New conversation'])
    expect(screen.getByRole('button', { name: 'Clear conversation' })).toBeDisabled()
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
