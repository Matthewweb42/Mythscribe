import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import { MessageSquare, Plus, Quote, Send, Square, X } from 'lucide-react'
import { AI_FEATURE_IDS, type AiFeatureId } from '@shared/ai'
import type { AgentStep } from '@shared/agent'
import { ROUTE_ACTION_LABEL } from '@shared/assistantRoute'
import { SUGGESTION_ROTATE_MS, assistantSuggestions } from '@shared/assistantSuggestions'
import {
  CHAT_MAX_CONVERSATIONS,
  CHAT_MESSAGE_MAX,
  CHAT_TITLE_MAX,
  type ChatMessage,
  type Conversation
} from '@shared/chat'
import {
  AI_DATA_SHARING,
  DEFAULT_ASSISTANT_MODE,
  isFeatureAllowed,
  needsSwitchText,
  type AssistantMode
} from '@shared/aiSettings'
import {
  CITATION_MARKER,
  QUERY_NOT_FOUND,
  type QueryCitation,
  type QuerySceneRef,
  type QueryTurn
} from '@shared/query'
import { docToText } from '@shared/docText'
import type { WhatNextDirection } from '@shared/whatNext'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { DockPanelControls } from '@renderer/features/shell/Dock'
import { InlineRenameInput } from '@renderer/features/shell/InlineRenameInput'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { APP_SHORTCUTS, matchesShortcut } from '@renderer/features/shell/shortcuts'
import { CONVERSATION_BUSY_MESSAGE, useOpenScene } from './aiActions'
import { AgentChanges, AgentSteps } from './AgentTurn'
import { AiResults } from './AiResults'
import { AssistantModeControl } from './AssistantModeControl'
import { useAiSettingsStore } from './aiSettingsStore'
import {
  AGENT_NOTICE,
  NO_SCENE_MESSAGE,
  PLAN_NO_EDITS_MESSAGE,
  useActiveConversation,
  useAssistantStore
} from './assistantStore'
import { ContinuityLink, ContinuityView } from './ContinuityPanel'
import { useContinuityStore } from './continuityStore'
import { RequestCost } from './RequestCost'

const ICON_BUTTON =
  'rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
/** What the panel says while Use AI is off; the chat no longer carries an Off position (2026-10-07). */
export const AI_OFF_MESSAGE =
  'AI is off for this project. Turn on Use AI in Settings › AI to use the assistant.'
const LINK_BUTTON =
  'text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-40 disabled:hover:no-underline'
/** A `[n]` marker inside an answer, and the chips under "Also mentioned in". */
const CITE_BUTTON =
  'rounded-sm px-0.5 align-baseline text-xs font-medium text-accent hover:bg-surface-raised hover:underline focus-visible:outline-2 focus-visible:outline-accent'
const CHIP_BUTTON =
  'rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'
/** The warning a Query answer no citation survived carries (F-5.7, author-control rule 4). */
export const QUERY_UNCITED_WARNING =
  'No cited passage supports this answer; treat it as unverified.'

/** What a What should come next? turn says when no direction survived (F-5.17). */
export const NO_DIRECTIONS_MESSAGE = 'No directions came back. Try again.'

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
 * The AI assistant panel (F-5.4): a dock panel (layout 3c; by default the rightmost column,
 * sized and resized by `DockColumn`), with one tab per conversation, the turns of the open one,
 * and the composer with the chat mode switch (Auto · Ask · Plan, one setting per project since
 * 2026-10-07). Every assistant turn shows what it cost. The open state
 * lives in the layout store (F-7.2); the conversations in `useAssistantStore`.
 * Renders nothing while closed. Not mounted in focus mode, where `AssistantBody` floats
 * instead (F-6.6).
 */
export function AssistantPanel(): React.JSX.Element | null {
  const assistant = useLayoutStore((s) => s.layout.assistant)
  if (!assistant.open) return null
  return (
    <aside
      aria-label="Assistant"
      data-testid="assistant-panel"
      className="flex min-h-0 flex-1 flex-col bg-surface"
    >
      <PanelHeader />
      <AssistantBody />
    </aside>
  )
}

/**
 * The conversation tabs, the open conversation's turns, and the composer: everything under
 * the heading. The docked panel and the floating window in focus mode (F-6.6) share it, and
 * so the same store, so a conversation started in one continues in the other. While the
 * Continuity link is pressed (F-13.4) the findings view takes the place of the chat. The
 * results of the scene features (`AiResults`, 2026-10-06) sit above both views, and the
 * Continuity link under them while there are findings.
 */
export function AssistantBody(): React.JSX.Element {
  const continuity = useContinuityStore((s) => s.viewOpen)
  return (
    <>
      <AiResults />
      <ContinuityLink />
      {continuity ? (
        <ContinuityView />
      ) : (
        <>
          <ConversationTabs />
          <MessageLog />
          <Composer />
        </>
      )}
    </>
  )
}

/**
 * The dock's grip and panel menu and the title, nothing else (2026-10-06, the author's polish:
 * no action buttons up here; the actions are chat turns Auto routes and the rotating suggestions
 * above the message box).
 */
function PanelHeader(): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1 pt-3 pr-3 pb-1 pl-2">
      <DockPanelControls id="assistant" />
      <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-fg-muted">Assistant</h2>
    </div>
  )
}

/**
 * The small + at the end of the conversation tabs: opens a fresh conversation (there is no
 * clearing one; a conversation leaves only by closing its tab). Disabled until the conversations
 * load and at the cap.
 */
export function NewConversationButton(): React.JSX.Element {
  const loaded = useAssistantStore((s) => s.conversations !== null)
  const count = useAssistantStore((s) => s.conversations?.items.length ?? 0)
  const newConversation = useAssistantStore((s) => s.newConversation)
  return (
    <button
      type="button"
      aria-label="New conversation"
      title="New conversation"
      disabled={!loaded || count >= CHAT_MAX_CONVERSATIONS}
      onClick={() => {
        // F-13.4: the new conversation is what the author wants to see, not the findings.
        useContinuityStore.getState().setViewOpen(false)
        newConversation()
      }}
      className={ICON_BUTTON}
    >
      <Plus size={14} aria-hidden="true" />
    </button>
  )
}

/**
 * One tab per conversation (an ARIA tablist with a roving tabindex like the sidebar's:
 * ArrowLeft/ArrowRight wrap, Home/End jump), then New conversation. Each tab's close button
 * shows only while the tab is hovered or the button has keyboard focus, so it is not hit by
 * accident. Tabs share the strip's width and truncate their titles, so the panel at its floor
 * shows no scrollbar until many are open. Closing a conversation with messages confirms first;
 * the last tab is replaced by a fresh one. Double-click or F2 renames a tab inline (2026-10-07).
 */
function ConversationTabs(): React.JSX.Element {
  const items = useAssistantStore((s) => s.conversations?.items ?? null)
  const active = useAssistantStore((s) => s.conversations?.active ?? null)
  const select = useAssistantStore((s) => s.select)
  const closeConversation = useAssistantStore((s) => s.closeConversation)
  const renameConversation = useAssistantStore((s) => s.renameConversation)
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const tablist = useRef<HTMLDivElement>(null)
  /** The tab to focus once its rename field is gone (Enter or Escape; a blur leaves focus where it went). */
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    if (renamingId !== null || refocus.current === null) return
    tabs.current.get(refocus.current)?.focus()
    refocus.current = null
  }, [renamingId])
  if (items === null) {
    return (
      <div className="flex shrink-0 justify-end border-b border-line px-1">
        <NewConversationButton />
      </div>
    )
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return // the rename field handles its own keys
    const index = items.findIndex((c) => c.id === active)
    let next: number
    switch (event.key) {
      case 'F2':
        event.preventDefault()
        setRenamingId(active)
        return
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
    <div className="flex shrink-0 items-center border-b border-line pr-1 pl-2">
      <div
        ref={tablist}
        role="tablist"
        aria-label="Conversations"
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {items.map((conversation) => {
          const selected = conversation.id === active
          return (
            <div
              key={conversation.id}
              className={`group flex min-w-14 max-w-40 flex-1 basis-0 items-center border-b-2 ${selected ? 'border-accent' : 'border-transparent'}`}
            >
              {renamingId === conversation.id ? (
                <InlineRenameInput
                  value={conversation.title}
                  label="Rename conversation"
                  maxLength={CHAT_TITLE_MAX}
                  onCommit={(next) => renameConversation(conversation.id, next)}
                  onDone={() => {
                    if (tablist.current?.contains(document.activeElement)) {
                      refocus.current = conversation.id
                    }
                    setRenamingId(null)
                  }}
                  className="mx-1 my-1 min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-xs text-fg outline-none"
                />
              ) : (
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
                  onDoubleClick={() => setRenamingId(conversation.id)}
                  className={`min-w-0 flex-1 truncate py-1.5 pr-1 pl-2 text-xs font-medium select-none hover:text-fg focus-visible:outline-none ${selected ? 'text-fg' : 'text-fg-muted'}`}
                >
                  {conversation.title}
                </button>
              )}
              <button
                type="button"
                aria-label={`Close ${conversation.title}`}
                title="Close conversation"
                onClick={() => void close(conversation)}
                className="shrink-0 rounded-md p-0.5 text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-raised hover:text-fg focus-visible:opacity-100"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      <NewConversationButton />
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
  const liveSteps = useAssistantStore((s) => {
    const requestId = conversation ? s.pending[conversation.id] : undefined
    return requestId === undefined ? undefined : s.agentSteps[requestId]
  })
  const log = useRef<HTMLDivElement>(null)
  const messages = conversation?.messages ?? []
  const lastId = messages[messages.length - 1]?.id ?? null
  const lastLength = messages[messages.length - 1]?.content.length ?? 0
  const stepCount = liveSteps?.length ?? 0

  useEffect(() => {
    const element = log.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lastId, lastLength, stepCount])

  return (
    <div
      ref={log}
      id="assistant-log"
      role="log"
      aria-label="Messages"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
    >
      {messages.length === 0 ? (
        <p className="m-auto max-w-64 text-center text-xs leading-relaxed text-fg-subtle">
          Ask about your story or ask for a change. The assistant looks things up in your project,
          then answers or edits: in Auto it makes its edits itself, in Ask every change waits for
          your Apply, and in Plan it only talks. Editor&apos;s notes, a proofread, or a rewrite of
          the selection work too.
        </p>
      ) : null}
      {messages.map((message, index) => (
        <Turn
          key={message.id}
          message={message}
          pending={pending && index === messages.length - 1}
          busy={pending}
          cached={cached[message.id] === true}
          liveSteps={index === messages.length - 1 ? (liveSteps ?? []) : []}
        />
      ))}
    </div>
  )
}

/**
 * One turn. The author's on the right; the assistant's on the left with its cost line once it
 * has one (`model · cost · cached`, F-4.7's note). An empty assistant turn with a request in
 * flight reads as thinking; an Author turn shows the notice, its text went to the editor; a
 * Query turn (F-5.7) shows its citations through `QueryAnswer`; a What should come next? turn
 * (F-5.17) shows its directions as cards through `Directions`. An agent turn (F-5.22) shows
 * its lookups live while it waits (`liveSteps`), then its answer, the lookups folded away, and
 * its edits (`AgentChanges`). `busy` is whether the conversation has a request in flight.
 */
function Turn({
  message,
  pending,
  busy,
  cached,
  liveSteps
}: {
  message: ChatMessage
  pending: boolean
  busy: boolean
  cached: boolean
  liveSteps: readonly AgentStep[]
}): React.JSX.Element {
  const mine = message.role === 'user'
  return (
    <article
      data-testid="chat-turn"
      data-role={message.role}
      aria-label={mine ? 'You' : 'Assistant'}
      className={`flex flex-col gap-1 text-sm leading-relaxed ${mine ? 'max-w-[85%] self-end rounded-lg rounded-br-sm bg-surface-raised px-3 py-1.5' : 'max-w-full self-start px-0.5'}`}
    >
      {!mine && message.action !== null && message.action !== 'chat' ? (
        <p data-testid="chat-turn-action" className="m-0 text-[11px] font-medium text-accent">
          {ROUTE_ACTION_LABEL[message.action]}
        </p>
      ) : null}
      {!mine && message.content === '' && pending ? (
        <div role="status" data-testid="chat-pending" className="flex flex-col gap-0.5">
          <p className="m-0 text-xs text-fg-muted">Thinking…</p>
          <AgentSteps steps={liveSteps} live />
        </div>
      ) : !mine && message.directions !== null ? (
        <Directions directions={message.directions} busy={busy} />
      ) : !mine && message.mode === 'agent' ? (
        <p className="m-0 text-xs text-fg-muted italic">{AGENT_NOTICE}</p>
      ) : !mine && message.query !== null ? (
        <QueryAnswer answer={message.content} query={message.query} />
      ) : (
        <p className="m-0 break-words whitespace-pre-wrap">{message.content}</p>
      )}
      {!mine && message.agent !== null ? (
        <>
          <AgentSteps steps={message.agent.steps} live={false} />
          <AgentChanges messageId={message.id} changes={message.agent.changes} />
        </>
      ) : null}
      {message.model !== null ? (
        <p data-testid="chat-turn-cost" className="m-0 text-[11px] text-fg-subtle">
          <RequestCost
            request={{
              model: message.model,
              costUsd: message.costUsd ?? 0,
              usage: message.usage,
              cached
            }}
          />
        </p>
      ) : null}
    </article>
  )
}

/**
 * The directions of a What should come next? turn (F-5.17), one card each with `Write this`,
 * which sends the direction to the chat agent with its edit tools, so the text comes back as an
 * insert edit (with the voice profile and the fidelity check that path carries): waiting for
 * Apply in Ask, applied in Auto. Disabled with the reason while the agent is not allowed, in
 * Plan (which never edits), without an open editor, or while the conversation waits.
 */
function Directions({
  directions,
  busy
}: {
  directions: readonly WhatNextDirection[]
  busy: boolean
}): React.JSX.Element {
  const settings = useAiSettingsStore((s) => s.settings)
  const hasEditor = useActiveEditorStore((s) => s.active !== null && !s.active.editor.isDestroyed)
  const writeDirection = useAssistantStore((s) => s.writeDirection)
  let reason: string | null = null
  if (settings === null || !isFeatureAllowed(settings, 'agent')) {
    reason = `${needsSwitchText('Write this')}, with ${AI_DATA_SHARING.agent.label} on (Settings, AI tab)`
  } else if (settings.chatMode === 'plan') {
    reason = PLAN_NO_EDITS_MESSAGE
  } else if (!hasEditor) {
    reason = NO_SCENE_MESSAGE
  } else if (busy) {
    reason = CONVERSATION_BUSY_MESSAGE
  }
  if (directions.length === 0) {
    return <p className="m-0 text-xs text-fg-muted italic">{NO_DIRECTIONS_MESSAGE}</p>
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
      {directions.map((direction, index) => (
        <li
          key={`${index}-${direction.title}`}
          data-testid="what-next-direction"
          className="flex flex-col gap-1 rounded-md bg-surface-raised p-2"
        >
          <p className="m-0 text-sm font-medium">{direction.title}</p>
          <p className="m-0 break-words text-xs text-fg-muted">{direction.text}</p>
          <button
            type="button"
            data-testid="what-next-write"
            disabled={reason !== null}
            title={
              reason ?? 'Continue the scene this way: the assistant proposes the text as an edit'
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void writeDirection(direction)}
            className={`self-start ${LINK_BUTTON}`}
          >
            Write this
          </button>
        </li>
      ))}
    </ol>
  )
}

/**
 * A Query answer (F-5.7): the "not found" line or the uncited warning when either applies, the
 * answer with every live `[n]` marker as a button that opens that scene at the passage it
 * rests on, the Sources list of the citations main verified against the text it sent, the
 * author's sheets it rests on (query.v3; a click opens the entity's page), and the ranked
 * scenes the answer did not cite. Nothing here enters the manuscript.
 */
function QueryAnswer({ answer, query }: { answer: string; query: QueryTurn }): React.JSX.Element {
  const openScene = useAssistantStore((s) => s.openScene)
  const open = (ref: QuerySceneRef, quote: string | null): void => {
    void openScene(ref, quote)
  }
  return (
    <div className="flex flex-col gap-1.5">
      {!query.found ? (
        <p data-testid="query-not-found" className="m-0 text-xs text-fg-muted italic">
          {QUERY_NOT_FOUND}
        </p>
      ) : null}
      {query.uncited ? (
        <p data-testid="query-uncited" role="status" className="m-0 text-xs text-warning">
          {QUERY_UNCITED_WARNING}
        </p>
      ) : null}
      <p className="m-0 break-words whitespace-pre-wrap">
        {answerParts(answer, query.citations, open)}
      </p>
      {query.citations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-fg-muted">Sources</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {query.citations.map((citation, index) => (
              <li key={`${citation.nodeId}-${index}`}>
                <button
                  type="button"
                  data-testid="query-citation"
                  data-scene={citation.scene}
                  title={`Open ${citation.title}`}
                  onClick={() => open(citation, citation.quote)}
                  className="w-full rounded-md border border-line px-2 py-1 text-left text-xs hover:bg-surface-raised"
                >
                  <span className="block font-medium text-fg">{citation.title}</span>
                  <span className="block text-fg-muted italic">“{citation.quote}”</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {query.sheets.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-fg-muted">From your notes</p>
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
            {query.sheets.map((sheet) => (
              <li key={sheet.entityId}>
                <button
                  type="button"
                  data-testid="query-sheet"
                  title={`Open ${sheet.name}`}
                  onClick={() => useEntityStore.getState().select(sheet.entityId)}
                  className={CHIP_BUTTON}
                >
                  {sheet.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {query.also.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-fg-muted">Also mentioned in</p>
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
            {query.also.map((ref) => (
              <li key={ref.nodeId}>
                <button
                  type="button"
                  data-testid="query-also"
                  title={`Open ${ref.title}`}
                  onClick={() => open(ref, null)}
                  className={CHIP_BUTTON}
                >
                  {ref.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The answer text with each `[n]` marker replaced by a button opening the first citation of
 * that scene at its passage. Main strips the markers no citation survived, so one that still
 * names an uncited scene is left as plain text.
 */
function answerParts(
  answer: string,
  citations: readonly QueryCitation[],
  open: (ref: QuerySceneRef, quote: string | null) => void
): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let cut = 0
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const marker = match[0]
    const label = `[${match[1] ?? ''}]`
    const at = match.index ?? 0
    const citation = citations.find((c) => c.scene === Number(match[1]))
    parts.push(answer.slice(cut, at) + marker.slice(0, marker.length - label.length))
    cut = at + marker.length
    if (citation === undefined) {
      parts.push(label)
      continue
    }
    parts.push(
      <button
        key={`cite-${at}`}
        type="button"
        data-testid="query-cite"
        data-scene={citation.scene}
        aria-label={`Open ${citation.title}`}
        title={`Open ${citation.title}`}
        onClick={() => open(citation, citation.quote)}
        className={CITE_BUTTON}
      >
        {label}
      </button>
    )
  }
  parts.push(answer.slice(cut))
  return parts
}

/**
 * The rotating suggestion line, the message box with Send (or Stop) inside it, and under it the
 * chat mode switch (Auto · Ask · Plan, 2026-10-07). Use AI lives in Settings › AI only; while it
 * is off the note above the box says so. Enter sends, Shift+Enter breaks the line; Send is disabled for a blank message and
 * while the settings do not allow the assistant (the note above says what to change). While a turn is in flight, Stop takes Send's place (F-5.10): it
 * drops the unanswered turn and keeps the author's, so it can be sent again. There is no
 * clearing a conversation (2026-10-06): New conversation starts a fresh one.
 */
function Composer(): React.JSX.Element {
  const conversation = useActiveConversation()
  const pending = useAssistantStore((s) =>
    conversation ? s.pending[conversation.id] !== undefined : false
  )
  const send = useAssistantStore((s) => s.send)
  const stop = useAssistantStore((s) => s.stop)
  const attachment = useAssistantStore((s) => s.attachment)
  const detach = useAssistantStore((s) => s.detach)
  const settings = useAiSettingsStore((s) => s.settings)
  const [draft, setDraft] = useState('')
  const [focusCount, setFocusCount] = useState(0)
  const messageBox = useRef<HTMLTextAreaElement>(null)

  // Ask AI (the selection bubble) attaches a passage: the author writes the question next.
  useEffect(() => {
    if (attachment !== null) messageBox.current?.focus()
  }, [attachment])

  // Every message is answered by the chat agent unless the router picks another feature.
  const chatAllowed =
    settings !== null && isFeatureAllowed(settings, 'chat') && isFeatureAllowed(settings, 'agent')
  const mode = settings?.chatMode ?? DEFAULT_ASSISTANT_MODE
  const canSend = conversation !== null && chatAllowed && !pending && draft.trim() !== ''

  const submit = (): void => {
    if (!canSend) return
    void send(draft)
    setDraft('')
  }

  const warning =
    settings !== null && !chatAllowed ? (
      <p data-testid="assistant-disabled" className="m-0 text-xs text-warning">
        {settings.dial === 0
          ? AI_OFF_MESSAGE
          : `${isFeatureAllowed(settings, 'chat') ? AI_DATA_SHARING.agent.label : AI_DATA_SHARING.chat.label} is turned off for this project (Settings, AI tab).`}
      </p>
    ) : null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-1 pb-3">
      {warning ?? (
        <SuggestionLine
          mode={mode}
          conversationId={conversation?.id ?? null}
          paused={draft !== ''}
          focusCount={focusCount}
          onPick={(text) => {
            setDraft(text)
            messageBox.current?.focus()
          }}
        />
      )}
      {attachment !== null ? (
        <div
          data-testid="assistant-attachment"
          className="flex items-start gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-fg-muted"
        >
          <Quote size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          <p className="m-0 line-clamp-3 min-w-0 flex-1 break-words italic">{attachment}</p>
          <button
            type="button"
            aria-label="Remove passage"
            title="Remove the passage from the message"
            onClick={detach}
            className="shrink-0 rounded-md p-0.5 text-fg-subtle hover:bg-surface hover:text-fg"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="relative">
        <textarea
          ref={messageBox}
          aria-label="Message"
          rows={2}
          maxLength={CHAT_MESSAGE_MAX}
          placeholder={attachment !== null ? 'Ask about this passage…' : 'Ask about your story…'}
          disabled={conversation === null}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setFocusCount((n) => n + 1)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          className="block w-full min-w-0 resize-none rounded-lg border border-line bg-bg py-2 pr-10 pl-3 text-sm"
        />
        <div className="absolute right-1.5 bottom-1.5 flex">
          {pending ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop this answer"
              data-testid="assistant-stop"
              onClick={stop}
              className="rounded-md border border-line bg-bg p-1.5 text-fg hover:bg-surface-raised"
            >
              <Square size={12} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              title="Send (Enter; Shift+Enter breaks the line)"
              data-testid="assistant-send"
              disabled={!canSend}
              onClick={submit}
              className="rounded-md bg-accent p-1.5 text-accent-fg hover:bg-accent-hover disabled:bg-transparent disabled:text-fg-subtle"
            >
              <Send size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AssistantModeControl />
      </div>
    </div>
  )
}

/** How long a suggestion takes to fade out before the next one fades in. */
const SUGGESTION_FADE_MS = 300

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * One suggestion above the message box (2026-10-06): small, muted, centred, picked locally by
 * `assistantSuggestions` from what the dial, the open scene, its selection, its synopsis and
 * notes, and the story bible's characters offer. It changes every `SUGGESTION_ROTATE_MS` with a
 * fade, and holds still while the message box has text or the pointer or focus is on it. With
 * reduced motion it never fades or runs on a timer: it changes each time the message box gains
 * focus. It changes with the conversation too. A click fills the message box; nothing is sent.
 */
function SuggestionLine({
  mode,
  conversationId,
  paused,
  focusCount,
  onPick
}: {
  mode: AssistantMode
  conversationId: string | null
  paused: boolean
  /** How often the message box has gained focus. */
  focusCount: number
  onPick: (text: string) => void
}): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const open = useOpenScene()
  const { editor, nodeId } = open
  const selection =
    useEditorState({
      editor,
      selector: () => (editor ? !editor.state.selection.empty : false)
    }) ?? false
  const synopsis = useSceneMetaStore((s) =>
    nodeId === null ? undefined : s.docs[nodeId]?.content?.synopsis
  )
  const notes = useNotesStore((s) => (nodeId === null ? undefined : s.docs[nodeId]?.content))
  const notesEmpty = useMemo(() => notes != null && docToText(notes).trim() === '', [notes])
  const entities = useEntityStore((s) => s.byId)
  const characters = useMemo(
    () =>
      Object.values(entities)
        .filter((entity) => entity.kind === 'character')
        .map((entity) => entity.name),
    [entities]
  )
  const allowed = useMemo(
    () =>
      new Set<AiFeatureId>(
        settings === null ? [] : AI_FEATURE_IDS.filter((id) => isFeatureAllowed(settings, id))
      ),
    [settings]
  )
  const [tick, setTick] = useState(0)
  const [shown, setShown] = useState(true)
  const [held, setHeld] = useState(false)
  const [reduced] = useState(prefersReducedMotion)

  // A new conversation gets a new suggestion.
  const [seenConversation, setSeenConversation] = useState(conversationId)
  if (seenConversation !== conversationId) {
    setSeenConversation(conversationId)
    setTick((n) => n + 1)
  }

  const step = tick + (reduced ? focusCount : 0)
  const list = assistantSuggestions(
    {
      mode,
      allowed,
      sceneLength: open.scene ? open.length : null,
      selection,
      synopsisEmpty: synopsis?.trim() === '',
      notesEmpty,
      characters
    },
    step
  )
  const rotates = list.length > 1 && !paused && !held && !reduced

  useEffect(() => {
    if (!rotates) return
    let fade: ReturnType<typeof setTimeout> | undefined
    const timer = setInterval(() => {
      setShown(false)
      fade = setTimeout(() => {
        setTick((n) => n + 1)
        setShown(true)
      }, SUGGESTION_FADE_MS)
    }, SUGGESTION_ROTATE_MS)
    return () => {
      clearInterval(timer)
      if (fade !== undefined) clearTimeout(fade)
      setShown(true)
    }
  }, [rotates])

  const text = list.length === 0 ? null : (list[step % list.length] ?? null)
  if (text === null) return null
  return (
    <button
      type="button"
      data-testid="assistant-suggestion"
      title="Use this suggestion (fills the message box)"
      onClick={() => onPick(text)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`mx-auto max-w-full truncate rounded px-2 text-center text-xs text-fg-muted hover:text-fg motion-safe:transition-opacity motion-safe:duration-300 ${shown ? 'opacity-70 hover:opacity-100' : 'opacity-0'}`}
    >
      {text}
    </button>
  )
}
