import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Plus, Send, Square, X } from 'lucide-react'
import {
  CHAT_MAX_CONVERSATIONS,
  CHAT_MESSAGE_MAX,
  CHAT_MODE_LABEL,
  CHAT_MODES,
  CHAT_PARAGRAPHS_MAX,
  CHAT_PARAGRAPHS_MIN,
  type ChatMessage,
  type ChatMode,
  type Conversation
} from '@shared/chat'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { LAYOUT_LIMITS } from '@shared/layout'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { resizePanelBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { APP_SHORTCUTS, matchesShortcut } from '@renderer/features/shell/shortcuts'
import { useAiSettingsStore } from './aiSettingsStore'
import { AGENT_NOTICE, useActiveConversation, useAssistantStore } from './assistantStore'
import { formatRequestCost } from './usageFormat'

const ICON_BUTTON =
  'rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const RADIO =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent aria-checked:border-accent aria-checked:bg-surface-raised aria-checked:text-accent'
const LINK_BUTTON =
  'text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-40 disabled:hover:no-underline'

/** The paragraph counts Agent mode offers, 1–10. */
const PARAGRAPH_OPTIONS = Array.from(
  { length: CHAT_PARAGRAPHS_MAX - CHAT_PARAGRAPHS_MIN + 1 },
  (_, i) => CHAT_PARAGRAPHS_MIN + i
)

/**
 * The header toggle for the assistant panel (F-5.4); `aria-pressed` reflects whether it is
 * open. Ctrl+K (Cmd+K on macOS) toggles it too: this component owns the listener and is
 * mounted only while a project is open, so the shortcut cannot fire on the welcome screen.
 */
export function AssistantToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.assistant.open)
  const toggle = useLayoutStore((s) => s.toggle)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, APP_SHORTCUTS.assistant.chord)) {
        event.preventDefault()
        useLayoutStore.getState().toggle('assistant')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <button
      type="button"
      aria-label="Assistant"
      title="Assistant (Ctrl+K)"
      aria-pressed={open}
      onClick={() => toggle('assistant')}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:text-fg"
    >
      <MessageSquare size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The AI assistant panel (F-5.4): a docked column on the right, resizable by its left edge,
 * with one tab per conversation, the turns of the open one, and the composer. Plan mode
 * answers in the chat (streamed); Agent mode places the answer in the active editor as ghost
 * text and the chat shows a notice. Every assistant turn shows what it cost. The open state
 * and width live in the layout store (F-7.2); the conversations in `useAssistantStore`.
 * Renders nothing while closed.
 */
export function AssistantPanel(): React.JSX.Element | null {
  const assistant = useLayoutStore((s) => s.layout.assistant)
  if (!assistant.open) return null
  return (
    <aside
      aria-label="Assistant"
      data-testid="assistant-panel"
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width: `${assistant.size * 100}vw` }}
    >
      <ResizeHandle
        side="left"
        value={assistant.size}
        min={LAYOUT_LIMITS.assistant[0]}
        max={LAYOUT_LIMITS.assistant[1]}
        ariaLabel="Resize assistant"
        onChange={(deltaPx) => resizePanelBy('assistant', deltaPx)}
      />
      <PanelHeader />
      <ConversationTabs />
      <MessageLog />
      <Composer />
    </aside>
  )
}

function PanelHeader(): React.JSX.Element {
  const loaded = useAssistantStore((s) => s.conversations !== null)
  const count = useAssistantStore((s) => s.conversations?.items.length ?? 0)
  const newConversation = useAssistantStore((s) => s.newConversation)
  return (
    <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1">
      <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-fg-muted">Assistant</h2>
      <button
        type="button"
        aria-label="New conversation"
        title="New conversation"
        disabled={!loaded || count >= CHAT_MAX_CONVERSATIONS}
        onClick={newConversation}
        className={ICON_BUTTON}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * One tab per conversation (an ARIA tablist with a roving tabindex like the sidebar's:
 * ArrowLeft/ArrowRight wrap, Home/End jump), each with a close button beside it. Tabs share
 * the strip's width and truncate their titles, so the panel at its floor shows no scrollbar
 * until many are open. Closing a conversation with messages confirms first; the last tab is
 * replaced by a fresh one.
 */
function ConversationTabs(): React.JSX.Element | null {
  const items = useAssistantStore((s) => s.conversations?.items ?? null)
  const active = useAssistantStore((s) => s.conversations?.active ?? null)
  const select = useAssistantStore((s) => s.select)
  const closeConversation = useAssistantStore((s) => s.closeConversation)
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  if (items === null) return null

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((c) => c.id === active)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % items.length
        break
      case 'ArrowLeft':
        next = (index - 1 + items.length) % items.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = items.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = items[next]
    if (!target) return
    select(target.id)
    tabs.current.get(target.id)?.focus()
  }

  const close = async (conversation: Conversation): Promise<void> => {
    if (conversation.messages.length > 0) {
      const ok = await dialogs.confirm({
        title: 'Close conversation',
        message: `Close "${conversation.title}"? Its messages will be lost.`,
        confirmLabel: 'Close',
        danger: true
      })
      if (!ok) return
    }
    closeConversation(conversation.id)
  }

  return (
    <div
      role="tablist"
      aria-label="Conversations"
      onKeyDown={onKeyDown}
      className="flex shrink-0 overflow-x-auto border-b border-line px-2"
    >
      {items.map((conversation) => {
        const selected = conversation.id === active
        return (
          <div
            key={conversation.id}
            className={`flex min-w-14 max-w-40 flex-1 basis-0 items-center border-b-2 ${selected ? 'border-accent' : 'border-transparent'}`}
          >
            <button
              ref={(element) => {
                if (element) tabs.current.set(conversation.id, element)
                else tabs.current.delete(conversation.id)
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="assistant-log"
              tabIndex={selected ? 0 : -1}
              title={conversation.title}
              onClick={() => select(conversation.id)}
              className={`min-w-0 flex-1 truncate py-1.5 pr-1 pl-2 text-xs font-medium select-none hover:text-fg focus-visible:outline-none ${selected ? 'text-fg' : 'text-fg-muted'}`}
            >
              {conversation.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${conversation.title}`}
              title="Close conversation"
              onClick={() => void close(conversation)}
              className="shrink-0 rounded-md p-0.5 text-fg-subtle hover:bg-surface-raised hover:text-fg"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** The turns of the open conversation, newest at the bottom and kept in view. */
function MessageLog(): React.JSX.Element {
  const conversation = useActiveConversation()
  const pending = useAssistantStore((s) =>
    conversation ? s.pending[conversation.id] !== undefined : false
  )
  const cached = useAssistantStore((s) => s.cached)
  const log = useRef<HTMLDivElement>(null)
  const messages = conversation?.messages ?? []
  const lastId = messages[messages.length - 1]?.id ?? null
  const lastLength = messages[messages.length - 1]?.content.length ?? 0

  useEffect(() => {
    const element = log.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lastId, lastLength])

  return (
    <div
      ref={log}
      id="assistant-log"
      role="log"
      aria-label="Messages"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2"
    >
      {messages.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">
          Ask about the open scene, or write #name to pull in that tag's notes. Agent mode places
          the answer in the editor as ghost text.
        </p>
      ) : null}
      {messages.map((message, index) => (
        <Turn
          key={message.id}
          message={message}
          pending={pending && index === messages.length - 1}
          cached={cached[message.id] === true}
        />
      ))}
    </div>
  )
}

/**
 * One turn. The author's on the right; the assistant's on the left with its cost line once it
 * has one (`model · cost · cached`, F-4.7's note). An empty assistant turn with a request in
 * flight reads as thinking; an Agent turn shows the notice, its text went to the editor.
 */
function Turn({
  message,
  pending,
  cached
}: {
  message: ChatMessage
  pending: boolean
  cached: boolean
}): React.JSX.Element {
  const mine = message.role === 'user'
  return (
    <article
      data-testid="chat-turn"
      data-role={message.role}
      aria-label={mine ? 'You' : 'Assistant'}
      className={`flex max-w-[92%] flex-col gap-1 rounded-md px-2.5 py-1.5 text-sm ${mine ? 'self-end bg-surface-raised' : 'self-start border border-line'}`}
    >
      {!mine && message.content === '' && pending ? (
        <p role="status" data-testid="chat-pending" className="m-0 text-xs text-fg-muted">
          Thinking…
        </p>
      ) : !mine && message.mode === 'agent' ? (
        <p className="m-0 text-xs text-fg-muted italic">{AGENT_NOTICE}</p>
      ) : (
        <p className="m-0 break-words whitespace-pre-wrap">{message.content}</p>
      )}
      {message.model !== null ? (
        <p data-testid="chat-turn-cost" className="m-0 text-xs text-fg-subtle">
          {`${message.model} · ${formatRequestCost(message.costUsd ?? 0)}${cached ? ' · cached' : ''}`}
        </p>
      ) : null}
    </article>
  )
}

/**
 * The mode, the paragraph count (Agent only), Clear conversation, and the message box. Enter
 * sends, Shift+Enter breaks the line; Send is disabled for a blank message and while the dial
 * does not allow the assistant (the note above says what to change). While a turn is in
 * flight, Stop takes Send's place (F-5.10): it drops the unanswered turn and keeps the
 * author's, so it can be sent again.
 */
function Composer(): React.JSX.Element {
  const conversation = useActiveConversation()
  const pending = useAssistantStore((s) =>
    conversation ? s.pending[conversation.id] !== undefined : false
  )
  const send = useAssistantStore((s) => s.send)
  const stop = useAssistantStore((s) => s.stop)
  const setMode = useAssistantStore((s) => s.setMode)
  const setParagraphs = useAssistantStore((s) => s.setParagraphs)
  const clearMessages = useAssistantStore((s) => s.clearMessages)
  const settings = useAiSettingsStore((s) => s.settings)
  const [draft, setDraft] = useState('')
  const radios = useRef(new Map<ChatMode, HTMLButtonElement>())

  const chatAllowed = settings !== null && isFeatureAllowed(settings, 'chat')
  const agentDial = AI_DATA_SHARING.ghostText.minDial
  const agentAllowed = settings !== null && settings.dial >= agentDial
  const mode = conversation?.mode ?? 'plan'
  const canSend =
    conversation !== null &&
    chatAllowed &&
    !pending &&
    draft.trim() !== '' &&
    !(mode === 'agent' && !agentAllowed)

  const submit = (): void => {
    if (!canSend) return
    void send(draft)
    setDraft('')
  }

  const selectMode = (next: ChatMode): void => {
    if (next === 'agent' && !agentAllowed) return
    setMode(next)
    radios.current.get(next)?.focus()
  }

  const onRadioKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const index = CHAT_MODES.indexOf(mode)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % CHAT_MODES.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + CHAT_MODES.length) % CHAT_MODES.length
        break
      default:
        return
    }
    event.preventDefault()
    const target = CHAT_MODES[next]
    if (target !== undefined) selectMode(target)
  }

  const clear = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Clear conversation',
      message: 'Remove every message in this conversation?',
      confirmLabel: 'Clear',
      danger: true
    })
    if (ok) clearMessages()
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
      {settings !== null && !chatAllowed ? (
        <p data-testid="assistant-disabled" className="m-0 text-xs text-warning">
          The assistant needs the AI dial at {AI_DIAL_LABEL[AI_DATA_SHARING.chat.minDial]} or
          higher, with Assistant chat on (Settings, AI tab).
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Mode" className="flex gap-1">
          {CHAT_MODES.map((id) => {
            const disabled = id === 'agent' && !agentAllowed
            return (
              <button
                key={id}
                ref={(element) => {
                  if (element) radios.current.set(id, element)
                  else radios.current.delete(id)
                }}
                type="button"
                role="radio"
                aria-checked={id === mode}
                tabIndex={id === mode ? 0 : -1}
                disabled={disabled}
                title={
                  disabled
                    ? `Agent needs the AI dial at ${AI_DIAL_LABEL[agentDial]} or higher (Settings, AI tab)`
                    : id === 'agent'
                      ? 'Place the answer in the editor as ghost text'
                      : 'Answer in the chat'
                }
                onClick={() => selectMode(id)}
                onKeyDown={onRadioKeyDown}
                className={RADIO}
              >
                {CHAT_MODE_LABEL[id]}
              </button>
            )
          })}
        </div>
        {mode === 'agent' ? (
          <label className="flex items-center gap-1 text-xs text-fg-muted">
            <span>Paragraphs</span>
            <select
              aria-label="Paragraphs"
              value={conversation?.paragraphs ?? CHAT_PARAGRAPHS_MIN}
              onChange={(event) => setParagraphs(Number(event.target.value))}
              className="rounded-md border border-line bg-bg px-1 py-0.5 text-xs text-fg"
            >
              {PARAGRAPH_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={!conversation || conversation.messages.length === 0 || pending}
          onClick={() => void clear()}
          className={`ml-auto ${LINK_BUTTON}`}
        >
          Clear conversation
        </button>
      </div>
      <textarea
        aria-label="Message"
        rows={3}
        maxLength={CHAT_MESSAGE_MAX}
        placeholder="Ask about your scene… Enter sends, Shift+Enter breaks the line"
        disabled={conversation === null}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
        className="min-w-0 resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
      />
      <div className="flex items-center justify-end">
        {pending ? (
          <button
            type="button"
            aria-label="Stop"
            title="Stop this answer"
            data-testid="assistant-stop"
            onClick={stop}
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-raised"
          >
            <Square size={12} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            title="Send (Enter)"
            data-testid="assistant-send"
            disabled={!canSend}
            onClick={submit}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent"
          >
            <Send size={12} aria-hidden="true" />
            Send
          </button>
        )}
      </div>
    </div>
  )
}
