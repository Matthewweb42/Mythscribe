import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import {
  AGENT_CARET_CHARS,
  AGENT_SELECTION_CHARS,
  isDeletion,
  isDraftIntent,
  isOpenAction,
  isRewriteIntent,
  settledAfterReload,
  type AgentAccess,
  type AgentChange,
  type AgentEdit,
  type AgentFocus,
  type AgentStep
} from '@shared/agent'
import {
  ROUTE_HISTORY_TURNS,
  ROUTE_SELECTION_PREVIEW_CHARS,
  type RouteAction
} from '@shared/assistantRoute'
import type { ClearGroup } from '@shared/bibleClear'
import { DEFAULT_ASSISTANT_MODE, type AssistantMode } from '@shared/aiSettings'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MAX_CONVERSATIONS,
  CHAT_MAX_MESSAGES,
  CHAT_MESSAGE_MAX,
  CHAT_PARAGRAPHS_DEFAULT,
  CHAT_TITLE_MAX,
  Conversations,
  agentAccessFor,
  appliesEditsItself,
  routeActionFor,
  titleFor,
  type ChatMessage,
  type ChatMode,
  type Conversation
} from '@shared/chat'
import type { AiAgentResult, AiRouteResult, AiWhatNextResult, Input } from '@shared/ipc/contract'
import type { QuerySceneRef } from '@shared/query'
import { WHAT_NEXT_QUESTION, directionMessage, recapQuestion } from '@shared/quickActions'
import { WHAT_NEXT_CHAR_BUDGET, directionsText, type WhatNextDirection } from '@shared/whatNext'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import {
  useActiveEditorStore,
  type ActiveEditor
} from '@renderer/features/editor/activeEditorStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { captureRewriteText } from '@renderer/features/editor/rewriteTarget'
import { useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { selectedText as plainSelection } from '@renderer/features/editor/selectedText'
import { locateText } from '@renderer/features/editor/locateText'
import {
  OPEN_SCENE_TIMEOUT_MS,
  PASSAGE_GONE_MESSAGE,
  openPassage
} from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { applyAgentEdit, openEditor } from './agentApply'
import { AgentEditError, removeInsertedProse } from '@renderer/features/editor/agentEditing'
import {
  acceptLanding,
  dismissLanding,
  draftReplacement,
  landDraft,
  resetLandings
} from './draftLanding'
import {
  aiActionReason,
  openSceneNow,
  rewriteReason,
  startSceneAction,
  type OpenScene
} from './aiActions'
import { useAiActivityStore } from './aiActivityStore'
import { useAiSettingsStore } from './aiSettingsStore'
import { proposalStore } from './proposalStore'

/** The title of a conversation nobody has written in yet. */
export const NEW_CONVERSATION_TITLE = 'New conversation'
/**
 * What a stored Author-mode turn shows (its text went to the editor as ghost text); Author mode
 * is gone since 2026-10-07, but conversations written in it still load.
 */
export const AGENT_NOTICE = 'Placed in the editor. Tab accepts, Escape dismisses.'
/** Why a rewrite has nothing to work on: no document editor is open. */
export const NO_EDITOR_MESSAGE = 'Open a scene to place text'
/** The toast when What should come next? has no open scene to read (F-5.17). */
export const NO_SCENE_MESSAGE = 'Open a scene first'
/** Why Write this does nothing in Plan, which never edits (2026-10-07). */
export const PLAN_NO_EDITS_MESSAGE = 'Plan never changes the book. Switch to Ask or Auto to write.'
/** What a routed rewrite turn says once the rewrite started (F-5.19). */
export const REWRITE_STARTED_MESSAGE = 'The rewrite is above the chat.'
/** The selected passage Ask AI attaches to the composer is cut to this many characters. */
export const ATTACHMENT_MAX = 1_000
// The passage jump lives in the editor feature (F-4.12 reuses it for mentions); the two
// constants are re-exported here because the Query panel and this store's tests read them.
export { OPEN_SCENE_TIMEOUT_MS, PASSAGE_GONE_MESSAGE }

/**
 * The one owner of the project's assistant conversations (F-5.4): the tabs, the open one,
 * every turn, and which conversations have a request in flight. Persistence is the
 * `presetsStore` pattern: every change applies at once and is written after the shared
 * debounce through `conversations:set`; a failed write reverts to the last persisted value and
 * toasts; the pending-save registry flushes it before the project closes. Main is stateless
 * about conversations: `send` carries the recent turns as `history` and fills the turn with the
 * model, cost, and proposal id when the request resolves.
 * Every message runs in the project's chat mode (`AiSettings.chatMode`, read when it is sent;
 * decided by the author 2026-10-07, replacing the per-conversation Auto/Query/Author/Plan
 * modes): the router (F-5.19, `ai:route`) picks which feature answers it, and the turn runs that
 * feature on the same turn pair: the chat agent (F-5.22, `ai:agent`) for chat, a read-only
 * agent turn for a Story Intelligence question, What should come next?, a rewrite of the
 * selection, or a scene action (`startSceneAction`), whose result shows in the panel or the
 * notes column while the turn carries the action's label and a notice saying where. A router
 * that is off falls back to chat. In Plan the agent gets only its read tools and a pick that
 * would propose an edit runs as chat instead (`routeActionFor`).
 * An agent turn looks things up in the project (each lookup shows on the waiting turn from
 * `ai:agentStep`), then the answer comes back whole and rides on its turn as `query` (the
 * citations main verified and the two flags the panel shows) and `agent` (the lookups and the
 * edits, each pending, applied, skipped, undone, or failed). In Ask each edit waits for Apply;
 * in Auto every edit but a deletion or an off-voice one is applied at once, with its Undo held
 * in memory for the session (F-9.15: a sheet or tag edit's Undo is the Changes log's, which
 * logged it under the turn). `openScene` opens a cited scene and selects the passage.
 * The quick actions (F-5.17) write into the active conversation through the same turns:
 * `recap` is a read-only agent turn with a fixed question about the open scene, `whatNext`
 * asks `ai:whatNext` and records the directions on the assistant turn, and `writeDirection`
 * sends one of them to the agent with its edit tools, so the text comes back as an insert edit
 * (not in Plan). One busy rule covers them all: nothing new starts while the active
 * conversation has a request in flight.
 * Ask AI on a selection attaches the passage to the composer (`attachment`); the next message
 * sent from the composer carries it as a quote.
 * Every request is tracked in the activity store and can be stopped (F-5.10): `stop` drops the
 * unanswered turn and keeps the author's turn to resend; the `CANCELLED` reply is silent.
 * Loaded with the tree on project open and cleared on close (`App.tsx`).
 */
interface AssistantState {
  /** The loaded conversations; null until `load` resolves (the panel renders its chrome disabled until then). */
  conversations: Conversations | null
  /** Conversation id → the request id of its turn in flight. */
  pending: Record<string, string>
  /** Message ids answered from the local cache this session (the cost line says so; not persisted). */
  cached: Record<string, true>
  /** The lookups of each agent turn still on its way, by request id (F-5.22; not persisted). */
  agentSteps: Record<string, AgentStep[]>
  /** The agent edits being applied or undone right now, by change id. */
  changing: Record<string, true>
  /**
   * 2026-10-07: the answer text of each agent turn still on its way, by request id, as it
   * streams (not persisted); the turn shows it in place of "Thinking…".
   */
  agentAnswer: Record<string, string>
  /** 2026-10-07: the prose being drafted for an edit, by change id, as it streams (not persisted). */
  drafts: Record<string, string>
  load: () => Promise<void>
  /** The selected passage Ask AI attached to the composer (2026-10-06), or null. */
  attachment: string | null
  /** Attaches a passage to the next message (cut to `ATTACHMENT_MAX`); blank text detaches. */
  attach: (text: string) => void
  detach: () => void
  /** The unsent message in the composer: it outlives the composer while side work shows (2026-10-10). */
  composerText: string
  setComposerText: (text: string) => void
  /** Cancels any pending write, drops the step subscription, and empties the store. */
  clear: () => void
  /** Opens a fresh conversation as the active tab; a no-op at the conversation cap. */
  newConversation: () => void
  /** Drops a conversation (its request in flight is stopped); the last tab is replaced by a fresh one. */
  closeConversation: (id: string) => void
  select: (id: string) => void
  /** Renames a conversation's tab (double-click or F2, 2026-10-07); blank is ignored, long is cut. */
  renameConversation: (id: string, title: string) => void
  /**
   * Sends one turn in the active conversation in the project's chat mode; ignored while one is
   * in flight or for a blank message. `override.agent` skips the router and runs the agent with
   * that access (the recap reads; Write this writes). An agent turn always carries the open
   * document, so the recap of F-5.17 needs nothing more to be about it.
   */
  send: (message: string, override?: SendOverride) => Promise<void>
  /**
   * What should come next? (F-5.17): three directions for the open scene, as a turn in the
   * active conversation. With a selection the text up to its end goes along; without one the
   * autosave is flushed and main reads the saved scene.
   */
  whatNext: () => Promise<void>
  /** What happened here? (F-5.17): a cited recap of the open scene, or of the selection, as a read-only agent turn. */
  recap: () => Promise<void>
  /**
   * Write this (F-5.17): sends a direction to the agent with its edit tools, so the text comes
   * back as an insert edit, waiting for Apply in Ask and applied in Auto. Not in Plan.
   */
  writeDirection: (direction: WhatNextDirection) => Promise<void>
  /** Stops the active conversation's request in flight: the unanswered turn goes, the author's turn stays. */
  stop: () => void
  /**
   * Opens the scene a Query citation names (F-5.7) and, with a quote, selects that passage in
   * it. A quote the scene no longer holds toasts; a null quote just opens the scene.
   */
  openScene: (ref: QuerySceneRef, quote: string | null) => Promise<void>
  /**
   * Applies one pending edit of an agent turn (F-5.22): the Ask view's Apply, and what Auto does
   * on its own for every edit that is neither a deletion nor off-voice. The turn records the
   * outcome; a failure stays on the line with its reason.
   */
  applyChange: (messageId: string, changeId: string) => Promise<void>
  /** Apply all remaining: the turn's pending edits but its deletions, one after the other. */
  applyAll: (messageId: string) => Promise<void>
  /**
   * Skips a pending edit; nothing changes in the book. 2026-10-07: an insertion showing in the
   * editor is dismissed, and one still being drafted is stopped.
   */
  skipChange: (messageId: string, changeId: string) => void
  /** 2026-10-07: the card's Accept for an insertion showing in the editor as ghost text (Tab). */
  acceptChange: (messageId: string, changeId: string) => void
  /**
   * F-5.25: ticks or unticks one line of a pending clear's card ("are these the things you want
   * to delete?"); kept on the turn, so a reload shows the card as the author left it.
   */
  tickClearOption: (
    messageId: string,
    changeId: string,
    option: { group: ClearGroup; id: string },
    checked: boolean
  ) => void
  /**
   * Takes an applied edit back (this session only: the undo lives in memory; for a sheet or tag
   * edit it calls the Changes log's undo, F-9.15).
   */
  undoChange: (messageId: string, changeId: string) => Promise<void>
}

/**
 * A turn that skips the router and runs the agent with `agent` access. A turn with an override
 * never carries the composer's attachment.
 */
export interface SendOverride {
  agent: AgentAccess
}

/** The project's chat mode now; Ask until the AI settings load. */
function chatModeNow(): AssistantMode {
  return useAiSettingsStore.getState().settings?.chatMode ?? DEFAULT_ASSISTANT_MODE
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: Conversations | null = null
/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
let unregister: (() => void) | null = null
let unsubscribeSteps: (() => void) | null = null
let unsubscribeAnswer: (() => void) | null = null
let counter = 0
/** Change id → how to take an applied agent edit back; gone with the session or the project. */
const undoers = new Map<string, () => Promise<void>>()
/** Change id → the request drafting its prose right now (2026-10-07), so Skip can stop it. */
const writing = new Map<string, string>()
/** Changes the author skipped while their prose was being drafted: the stop reads as a skip. */
const skipped = new Set<string>()

const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++counter}`

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** Writes the current conversations now. The revert baseline survives a failure of a later write. */
async function write(): Promise<void> {
  cancelTimer()
  const value = useAssistantStore.getState().conversations
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('conversations:set', value)
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useAssistantStore.setState({ conversations: revertTo })
    throw err
  }
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

/** Writes a pending change at once, or nothing when the store is in sync. Used by the pending-save registry. */
async function flush(): Promise<void> {
  if (persisted === null) return
  await write()
}

/** Applies `next` at once and schedules the write. Ignored when nothing is loaded or the result does not parse. */
function commit(next: Conversations): void {
  const base = useAssistantStore.getState().conversations
  if (base === null) return
  const parsed = Conversations.safeParse(next)
  if (!parsed.success) return
  persisted ??= base
  useAssistantStore.setState({ conversations: parsed.data })
  cancelTimer()
  timer = setTimeout(() => {
    write().catch(reportFailure)
  }, SETTINGS_SAVE_DELAY_MS)
}

function freshConversation(): Conversation {
  const now = new Date().toISOString()
  return {
    id: nextId('c'),
    title: NEW_CONVERSATION_TITLE,
    paragraphs: CHAT_PARAGRAPHS_DEFAULT,
    messages: [],
    created: now,
    modified: now
  }
}

/** The stored state with at least one conversation open, so the panel always has a tab to write in. */
function withOne(value: Conversations): Conversations {
  if (value.items.length > 0) {
    const active = value.items.some((c) => c.id === value.active)
      ? value.active
      : (value.items[0]?.id ?? null)
    return active === value.active ? value : { ...value, active }
  }
  const fresh = freshConversation()
  return { active: fresh.id, items: [fresh] }
}

const turn = (role: ChatMessage['role'], content: string, mode: ChatMode | null): ChatMessage => ({
  id: nextId('m'),
  role,
  content,
  created: new Date().toISOString(),
  proposalId: null,
  model: null,
  costUsd: null,
  usage: null,
  mode,
  query: null,
  directions: null,
  action: null,
  agent: null
})

/** Records one lookup of an agent turn on its way, under the request it belongs to. */
function onAgentStep({ requestId, step }: { requestId: string; step: AgentStep }): void {
  if (conversationOfRequest(requestId) === null) return
  useAssistantStore.setState((s) => ({
    agentSteps: { ...s.agentSteps, [requestId]: [...(s.agentSteps[requestId] ?? []), step] }
  }))
}

/**
 * Records a streamed piece of an agent turn's answer (2026-10-07); `reset` voids what came so
 * far (main asked the step again after a reply was cut off).
 */
function onAgentDelta({
  requestId,
  delta,
  reset
}: {
  requestId: string
  delta: string
  reset: boolean
}): void {
  if (conversationOfRequest(requestId) === null) return
  useAssistantStore.setState((s) => ({
    agentAnswer: {
      ...s.agentAnswer,
      [requestId]: reset ? '' : `${s.agentAnswer[requestId] ?? ''}${delta}`
    }
  }))
}

function dropSteps(requestId: string): void {
  useAssistantStore.setState((s) => {
    if (s.agentSteps[requestId] === undefined && s.agentAnswer[requestId] === undefined) return {}
    const agentSteps = { ...s.agentSteps }
    delete agentSteps[requestId]
    const agentAnswer = { ...s.agentAnswer }
    delete agentAnswer[requestId]
    return { agentSteps, agentAnswer }
  })
}

/** The prose being drafted for change `changeId` so far; null drops it. */
function setDraft(changeId: string, text: string | null): void {
  useAssistantStore.setState((s) => {
    const drafts = { ...s.drafts }
    if (text === null) delete drafts[changeId]
    else drafts[changeId] = text
    return { drafts }
  })
}

/** The stored conversations as a reload finds them: no draft is still in flight or showing. */
function settledConversations(value: Conversations): Conversations {
  return {
    ...value,
    items: value.items.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((m) =>
        m.agent === null
          ? m
          : { ...m, agent: { ...m.agent, changes: m.agent.changes.map(settledAfterReload) } }
      )
    }))
  }
}

/** An edit whose prose the app drafts first (2026-10-07). */
function isIntent(edit: AgentEdit): boolean {
  return isDraftIntent(edit) || isRewriteIntent(edit)
}

/** Whether `undoChange` can still take this change back (its undo lives in memory). */
export function canUndoChange(changeId: string): boolean {
  return undoers.has(changeId)
}

/**
 * A conversation's title once `firstMessage` is written in it: the message, while the tab still
 * has the fresh title and no turns; a title the author gave it stays.
 */
function titledBy(conversation: Conversation, firstMessage: string): string {
  if (conversation.messages.length > 0 || conversation.title !== NEW_CONVERSATION_TITLE) {
    return conversation.title
  }
  return titleFor(firstMessage) || NEW_CONVERSATION_TITLE
}

/** `value` with conversation `id` replaced by `patch(conversation)`, its `modified` bumped. */
function patchOne(
  value: Conversations,
  id: string | null,
  patch: (conversation: Conversation) => Conversation
): Conversations {
  if (id === null) return value
  return {
    ...value,
    items: value.items.map((c) =>
      c.id === id ? { ...patch(c), modified: new Date().toISOString() } : c
    )
  }
}

/** The conversation whose request `requestId` is, if any. */
function conversationOfRequest(requestId: string): string | null {
  const { pending } = useAssistantStore.getState()
  return Object.keys(pending).find((id) => pending[id] === requestId) ?? null
}

function setPending(id: string, requestId: string | null): void {
  useAssistantStore.setState((s) => {
    const pending = { ...s.pending }
    if (requestId === null) delete pending[id]
    else pending[id] = requestId
    return { pending }
  })
}

/**
 * Removes the unanswered assistant turn a failed, stopped, or abandoned request left at the end
 * of the conversation: only a resolved request fills in the model.
 */
function dropUnanswered(value: Conversations, id: string): Conversations {
  return patchOne(value, id, (c) => {
    const last = c.messages[c.messages.length - 1]
    if (last?.role !== 'assistant' || last.model !== null) return c
    return { ...c, messages: c.messages.slice(0, -1) }
  })
}

/**
 * Fills the unanswered assistant turn at the end of conversation `id` with `answer` (its text,
 * cost, and whatever rides on it) and clears the pending request; a cached answer is noted.
 */
function finishTurn(id: string, answer: Partial<ChatMessage>, cached: boolean): void {
  setPending(id, null)
  const current = useAssistantStore.getState().conversations
  if (current === null) return
  const turnId = current.items.find((c) => c.id === id)?.messages.at(-1)?.id ?? null
  commit(
    patchOne(current, id, (c) => {
      const last = c.messages[c.messages.length - 1]
      if (last?.role !== 'assistant') return c
      return { ...c, messages: [...c.messages.slice(0, -1), { ...last, ...answer }] }
    })
  )
  if (cached && turnId !== null) {
    useAssistantStore.setState((s) => ({ cached: { ...s.cached, [turnId]: true } }))
  }
}

/** The live editor the author last worked in, or null. */
function liveEditor(): ActiveEditor | null {
  const active = useActiveEditorStore.getState().active
  return active !== null && !active.editor.isDestroyed ? active : null
}

/** The selected text of `editor`, or null for a caret. */
function selectedText(editor: Editor): string | null {
  const { from, to, empty } = editor.state.selection
  return empty ? null : editor.state.doc.textBetween(from, to, '\n\n')
}

/** Stops the request `id` is waiting on, if any, through the activity store; its reply is then dropped. */
function cancelRequest(id: string): void {
  const requestId = useAssistantStore.getState().pending[id]
  if (requestId !== undefined) void useAiActivityStore.getState().cancel(requestId)
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  conversations: null,
  pending: {},
  cached: {},
  agentSteps: {},
  changing: {},
  agentAnswer: {},
  drafts: {},
  attachment: null,

  attach(text) {
    const passage = text.trim()
    set({
      attachment:
        passage === ''
          ? null
          : passage.length > ATTACHMENT_MAX
            ? `${passage.slice(0, ATTACHMENT_MAX - 1).trimEnd()}…`
            : passage
    })
  },

  composerText: '',
  setComposerText(text) {
    set({ composerText: text })
  },
  detach() {
    set({ attachment: null })
  },

  async load() {
    unregister ??= registerPendingSave(flush)
    unsubscribeSteps ??= ipc().on('ai:agentStep', onAgentStep)
    unsubscribeAnswer ??= ipc().on('ai:agentDelta', onAgentDelta)
    const mine = ++generation
    const value = await ipc().invoke('conversations:get', undefined)
    if (mine !== generation) return
    // A fresh project gets an in-memory conversation to write in; it is persisted with its first change.
    set({ conversations: withOne(settledConversations(value)) })
  },

  clear() {
    generation++
    cancelTimer()
    persisted = null
    unregister?.()
    unregister = null
    unsubscribeSteps?.()
    unsubscribeSteps = null
    unsubscribeAnswer?.()
    unsubscribeAnswer = null
    undoers.clear()
    writing.clear()
    skipped.clear()
    resetLandings()
    set({
      conversations: null,
      pending: {},
      cached: {},
      agentSteps: {},
      changing: {},
      agentAnswer: {},
      drafts: {},
      attachment: null,
      composerText: ''
    })
  },

  newConversation() {
    const value = get().conversations
    if (value === null || value.items.length >= CHAT_MAX_CONVERSATIONS) return
    const fresh = freshConversation()
    commit({ active: fresh.id, items: [...value.items, fresh] })
  },

  closeConversation(id) {
    const value = get().conversations
    if (!value?.items.some((c) => c.id === id)) return
    cancelRequest(id)
    setPending(id, null)
    const index = value.items.findIndex((c) => c.id === id)
    const items = value.items.filter((c) => c.id !== id)
    const neighbour = items[Math.min(index, items.length - 1)]?.id ?? null
    const active = value.active === id ? neighbour : value.active
    commit(withOne({ active, items }))
  },

  select(id) {
    const value = get().conversations
    if (value === null || value.active === id || !value.items.some((c) => c.id === id)) return
    commit({ ...value, active: id })
  },

  renameConversation(id, title) {
    const value = get().conversations
    const next = title.trim().slice(0, CHAT_TITLE_MAX).trimEnd()
    if (value === null || next.length === 0) return
    const conversation = value.items.find((c) => c.id === id)
    if (!conversation || conversation.title === next) return
    commit(patchOne(value, id, (c) => ({ ...c, title: next })))
  },

  async send(message, override) {
    const value = get().conversations
    // The composer's attachment rides on a plain send only; an override (recap, Write this) is its own message.
    const attachment = override === undefined ? get().attachment : null
    const text = withAttachment(message.trim(), attachment)
    if (value?.active == null || !message.trim()) return
    const id = value.active
    const conversation = value.items.find((c) => c.id === id)
    if (!conversation || get().pending[id] !== undefined) return
    const mode = chatModeNow()
    if (attachment !== null) set({ attachment: null })
    const history = historyOf(conversation)
    const requestId = nextId('r')
    setPending(id, requestId)
    // A direct agent turn is labelled now (a cited lookup reads as Query, an edit turn as chat);
    // a routed one once the router has picked.
    const turnMode: ChatMode | null =
      override === undefined ? null : override.agent === 'read' ? 'query' : 'plan'
    commit(
      patchOne(value, id, (c) => ({
        ...c,
        title: titledBy(c, text),
        messages: [...c.messages, turn('user', text, null), turn('assistant', '', turnMode)].slice(
          -CHAT_MAX_MESSAGES
        )
      }))
    )
    if (override !== undefined) {
      const nodeId = useActiveEditorStore.getState().active?.id ?? null
      await runAgentTurn(id, requestId, override.agent, appliesEditsItself(mode), {
        nodeId,
        message: text,
        history
      })
      return
    }
    await routeTurn(id, requestId, text, history, mode)
  },

  async whatNext() {
    const value = get().conversations
    if (value?.active == null) return
    const id = value.active
    const conversation = value.items.find((c) => c.id === id)
    if (!conversation || get().pending[id] !== undefined) return
    const active = liveEditor()
    if (active === null) {
      toast.error(NO_SCENE_MESSAGE)
      return
    }
    const requestId = nextId('r')
    setPending(id, requestId)
    commit(
      patchOne(value, id, (c) => ({
        ...c,
        title: titledBy(c, WHAT_NEXT_QUESTION),
        messages: [
          ...c.messages,
          turn('user', WHAT_NEXT_QUESTION, null),
          turn('assistant', '', 'plan')
        ].slice(-CHAT_MAX_MESSAGES)
      }))
    )
    await runWhatNext(id, requestId, active)
  },

  async recap() {
    const active = liveEditor()
    const selection = active === null ? null : selectedText(active.editor)
    await get().send(recapQuestion(selection), { agent: 'read' })
  },

  async writeDirection(direction) {
    if (agentAccessFor(chatModeNow()) === 'read') {
      toast.error(PLAN_NO_EDITS_MESSAGE)
      return
    }
    await get().send(directionMessage(direction), { agent: 'write' })
  },

  stop() {
    const value = get().conversations
    if (value?.active == null) return
    const id = value.active
    const requestId = get().pending[id]
    if (requestId === undefined) return
    // The turn leaves now, so the author can resend at once; the cancelled reply finds nothing pending.
    settleFailure(id, requestId, null)
    void useAiActivityStore.getState().cancel(requestId)
  },

  async applyChange(messageId, changeId) {
    const found = findChange(messageId, changeId)
    if (found?.change.status !== 'pending' || get().changing[changeId]) return
    // 2026-10-07: prose the app drafts first; Apply on one asks for it (an insertion lands in
    // the editor as ghost text and waits for Tab there).
    if (isIntent(found.change.edit)) {
      await writeIntent(messageId, changeId, false)
      return
    }
    const drafted = found.change.proposalId
    setChanging(changeId, true)
    try {
      // F-9.15: story-bible edits are logged in Changes under the turn; their Undo is the log's.
      // F-5.25 (agent.v8): undoing the last turn is the chat's own, here; it has no Undo itself.
      const undo =
        found.change.edit.kind === 'undoTurn'
          ? await undoLastTurn(messageId)
          : await applyAgentEdit(found.change.edit, drafted ?? found.message.proposalId ?? '', {
              source: 'chat',
              run: messageId
            })
      if (undo !== null) undoers.set(changeId, undo)
      patchChange(messageId, changeId, { status: 'applied', error: null })
      if (drafted !== null) void proposalStore.settle(drafted, 'accepted', null)
    } catch (err) {
      patchChange(messageId, changeId, { status: 'failed', error: describeError(err) })
    } finally {
      setChanging(changeId, false)
    }
    settleChanges(messageId)
  },

  async applyAll(messageId) {
    const found = findMessage(messageId)
    // Deletions are never part of it: each asks on its own (F-5.21).
    const ids = (found?.agent?.changes ?? [])
      .filter((change) => change.status === 'pending' && !isDeletion(change.edit))
      .map((change) => change.id)
    for (const changeId of ids) await get().applyChange(messageId, changeId)
  },

  skipChange(messageId, changeId) {
    const found = findChange(messageId, changeId)
    if (found === null || get().changing[changeId]) return
    if (found.change.status === 'shown') {
      // Its landing settles the turn once the suggestion has left the editor.
      dismissLanding(changeId)
      return
    }
    if (found.change.status === 'writing') {
      const requestId = writing.get(changeId)
      skipped.add(changeId)
      if (requestId !== undefined) void useAiActivityStore.getState().cancel(requestId)
      return
    }
    if (found.change.status !== 'pending') return
    patchChange(messageId, changeId, { status: 'skipped' })
    if (found.change.proposalId !== null) {
      void proposalStore.settle(found.change.proposalId, 'rejected', null)
    }
    settleChanges(messageId)
  },

  acceptChange(_messageId, changeId) {
    acceptLanding(changeId)
  },

  tickClearOption(messageId, changeId, option, checked) {
    const found = findChange(messageId, changeId)
    const edit = found?.change.edit
    if (found?.change.status !== 'pending' || edit?.kind !== 'clear') return
    if (get().changing[changeId]) return
    patchChange(messageId, changeId, {
      edit: {
        ...edit,
        options: edit.options.map((line) =>
          line.group === option.group && line.id === option.id ? { ...line, checked } : line
        )
      }
    })
  },

  async undoChange(messageId, changeId) {
    const found = findChange(messageId, changeId)
    const undo = undoers.get(changeId)
    if (found?.change.status !== 'applied' || undo === undefined) return
    if (get().changing[changeId]) return
    setChanging(changeId, true)
    try {
      await undo()
      undoers.delete(changeId)
      patchChange(messageId, changeId, { status: 'undone', error: null })
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setChanging(changeId, false)
    }
  },

  async openScene(ref, quote) {
    // The tree's selection drives the editor pane, so selecting the node opens the scene; a chip
    // without a quote asks for nothing more, so it never waits for the editor.
    if (quote === null) {
      useTreeStore.getState().select(ref.nodeId)
      return
    }
    await openPassage(ref.nodeId, (doc) => locateText(doc, quote))
  }
}))

/** The recent turns that ride along with a request as history. */
function historyOf(conversation: Conversation): Input<'ai:chat'>['history'] {
  return conversation.messages
    .filter((m) => m.content !== '')
    .slice(-CHAT_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }))
}

/**
 * The message as sent: the author's words, then the attached passage as a quote, within the
 * message cap (the author's words are cut first; the quote is capped already).
 */
export function withAttachment(message: string, attachment: string | null): string {
  if (attachment === null) return message.slice(0, CHAT_MESSAGE_MAX)
  const quote = `\n\nPassage:\n"${attachment}"`
  return `${message.slice(0, Math.max(0, CHAT_MESSAGE_MAX - quote.length))}${quote}`
}

/** Applies `patch` to the unanswered assistant turn at the end of conversation `id`. */
function patchLastTurn(id: string, patch: Partial<ChatMessage>): void {
  const value = useAssistantStore.getState().conversations
  if (value === null) return
  commit(
    patchOne(value, id, (c) => {
      const last = c.messages[c.messages.length - 1]
      if (last?.role !== 'assistant') return c
      return { ...c, messages: [...c.messages.slice(0, -1), { ...last, ...patch }] }
    })
  )
}

/** Hands conversation `id`'s turn to a new request (the router answered; the feature's request starts). */
function nextRequest(id: string): string {
  const requestId = nextId('r')
  setPending(id, requestId)
  return requestId
}

/**
 * What should come next? (F-5.17) on the turn pair already in conversation `id`. With a
 * selection the directions follow from the text up to its end; the contract caps it.
 */
async function runWhatNext(id: string, requestId: string, active: ActiveEditor): Promise<void> {
  const { editor } = active
  const nodeId = active.id
  const before = editor.state.selection.empty
    ? null
    : editor.state.doc
        .textBetween(0, editor.state.selection.to, '\n\n')
        .slice(-WHAT_NEXT_CHAR_BUDGET)
  let result: AiWhatNextResult
  try {
    // Main reads the saved scene when no selection rides along: the author's typing goes first.
    await useDocumentStore.getState().flush()
    if (useAssistantStore.getState().pending[id] !== requestId) return // stopped or closed while saving
    result = await useAiActivityStore
      .getState()
      .track('whatNext', requestId, ipc().invoke('ai:whatNext', { nodeId, requestId, before }))
  } catch (err) {
    settleFailure(id, requestId, describeError(err))
    return
  }
  if (useAssistantStore.getState().pending[id] !== requestId) {
    // The conversation was closed or the store cleared meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    settleFailure(
      id,
      requestId,
      result.code === 'CANCELLED' ? null : `${result.message} ${result.nextStep}`.trim()
    )
    return
  }
  finishTurn(
    id,
    {
      content: directionsText(result.directions),
      directions: result.directions,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
      proposalId: result.proposalId
    },
    result.cached
  )
}

/**
 * One routed turn (F-5.19) in chat mode `mode`: asks the router which feature answers `text`,
 * with the open document, the opening of the selection, and the last turns, then runs that
 * feature on the turn pair already in conversation `id` (in Plan, only a pick that edits
 * nothing; any other becomes chat). The router being off (DISABLED) falls back to chat; any
 * other failure settles the turn as a chat failure would.
 */
async function routeTurn(
  id: string,
  requestId: string,
  text: string,
  history: Input<'ai:chat'>['history'],
  mode: AssistantMode
): Promise<void> {
  const open = openSceneNow()
  const { editor } = open
  const preview =
    editor !== null && !editor.state.selection.empty
      ? plainSelection(editor).slice(0, ROUTE_SELECTION_PREVIEW_CHARS)
      : ''
  let route: AiRouteResult
  try {
    route = await useAiActivityStore.getState().track(
      'route',
      requestId,
      ipc().invoke('ai:route', {
        nodeId: open.nodeId,
        message: text,
        history: history.slice(-ROUTE_HISTORY_TURNS),
        selection: preview === '' ? null : { text: preview },
        requestId
      })
    )
  } catch (err) {
    settleFailure(id, requestId, describeError(err))
    return
  }
  if (useAssistantStore.getState().pending[id] !== requestId) return // stopped or closed meanwhile
  let action: RouteAction = 'chat'
  let instruction: string | null = null
  let cost: Partial<ChatMessage> = {}
  if (route.ok) {
    action = route.action
    instruction = route.instruction
    if (route.model !== null) {
      cost = { model: route.model, costUsd: route.costUsd, usage: route.usage }
    }
  } else if (route.code !== 'DISABLED') {
    settleFailure(
      id,
      requestId,
      route.code === 'CANCELLED' ? null : `${route.message} ${route.nextStep}`.trim()
    )
    return
  }
  await dispatchRoute(id, {
    action: routeActionFor(mode, action),
    instruction,
    cost,
    text,
    history,
    open,
    mode
  })
}

/** What the router decided for one Auto turn, and what the turn carries into the feature. */
interface RoutedTurn {
  action: RouteAction
  instruction: string | null
  /** The router's own cost, shown on a turn whose feature answers outside the chat. */
  cost: Partial<ChatMessage>
  text: string
  history: Input<'ai:chat'>['history']
  open: OpenScene
  /** The chat mode the turn was sent in. */
  mode: AssistantMode
}

/** Runs the feature the router picked on conversation `id`'s turn pair, labelled with the action. */
async function dispatchRoute(id: string, routed: RoutedTurn): Promise<void> {
  const { action, instruction, cost, text, history, open, mode } = routed
  const { editor, nodeId } = open
  const autoApply = appliesEditsItself(mode)
  switch (action) {
    case 'chat': {
      // F-5.22: the chat is the agent, which may look things up and, in Ask and Auto, edit the book.
      patchLastTurn(id, { action, mode: 'plan' })
      await runAgentTurn(id, nextRequest(id), agentAccessFor(mode), autoApply, {
        nodeId,
        message: text,
        history
      })
      return
    }
    case 'query': {
      patchLastTurn(id, { action, mode: 'query' })
      await runAgentTurn(id, nextRequest(id), 'read', autoApply, {
        nodeId,
        message: text,
        history
      })
      return
    }
    case 'whatNext': {
      patchLastTurn(id, { action, mode: 'plan' })
      const active = liveEditor()
      if (active === null) {
        finishTurn(id, { content: NO_SCENE_MESSAGE, ...cost }, false)
        return
      }
      await runWhatNext(id, nextRequest(id), active)
      return
    }
    case 'rewrite': {
      patchLastTurn(id, { action })
      const settings = useAiSettingsStore.getState().settings
      const length = editor === null ? 0 : captureRewriteText(editor).text.length
      const reason = editor === null ? NO_EDITOR_MESSAGE : rewriteReason(settings, length)
      if (reason === null && editor !== null && nodeId !== null) {
        useRewriteStore.getState().start(nodeId, editor, instruction)
      }
      finishTurn(id, { content: reason ?? REWRITE_STARTED_MESSAGE, ...cost }, false)
      return
    }
    default: {
      patchLastTurn(id, { action })
      const settings = useAiSettingsStore.getState().settings
      const reason = aiActionReason(action, settings, open, false)
      let content = reason ?? NO_SCENE_MESSAGE
      if (reason === null && editor !== null && nodeId !== null) {
        content = startSceneAction(action, nodeId, editor, instruction)
      }
      finishTurn(id, { content, ...cost }, false)
    }
  }
}

/** The open document's caret window and selection, as an agent turn carries them (F-5.22). */
function focusOf(): AgentFocus {
  const active = liveEditor()
  if (active === null) return { beforeCaret: '', selection: '' }
  const { doc, selection } = active.editor.state
  return {
    beforeCaret: doc.textBetween(0, selection.from, '\n\n').slice(-AGENT_CARET_CHARS),
    selection: selection.empty
      ? ''
      : doc.textBetween(selection.from, selection.to, '\n\n').slice(0, AGENT_SELECTION_CHARS)
  }
}

/** What an agent turn asks about, beside its access. */
interface AgentAsk {
  nodeId: string | null
  message: string
  history: Input<'ai:agent'>['history']
}

/**
 * One chat agent turn (F-5.22) on the turn pair already in conversation `id`: main looks things
 * up (each lookup shows on the pending turn as it starts), then answers; the answer lands whole
 * with its verified citations (shown as a Query answer) and its edits, each pending. With
 * `autoApply` (the turn was sent in Auto), every edit that is neither a deletion nor off-voice
 * is then applied, one after the other, and logged on the turn with its Undo; the rest wait for
 * Apply. A read-only turn (Plan, a lookup) never has edits.
 */
async function runAgentTurn(
  id: string,
  requestId: string,
  access: AgentAccess,
  autoApply: boolean,
  ask: AgentAsk
): Promise<void> {
  let result: AiAgentResult
  try {
    // Main reads the saved book: the words typed just before asking go first.
    await useDocumentStore.getState().flush()
    if (useAssistantStore.getState().pending[id] !== requestId) return // stopped while saving
    result = await useAiActivityStore
      .getState()
      .track(
        'agent',
        requestId,
        ipc().invoke('ai:agent', { ...ask, access, focus: focusOf(), requestId })
      )
  } catch (err) {
    dropSteps(requestId)
    settleFailure(id, requestId, describeError(err))
    return
  }
  dropSteps(requestId)
  if (useAssistantStore.getState().pending[id] !== requestId) {
    // The conversation was closed or the store cleared meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    settleFailure(
      id,
      requestId,
      result.code === 'CANCELLED' ? null : `${result.message} ${result.nextStep}`.trim()
    )
    return
  }
  const changes: AgentChange[] = result.changes.map((change) => ({
    id: nextId('e'),
    edit: change.edit,
    status: 'pending',
    violation: change.violation,
    error: null,
    proposalId: null,
    notice: null
  }))
  const messageId =
    useAssistantStore
      .getState()
      .conversations?.items.find((c) => c.id === id)
      ?.messages.at(-1)?.id ?? null
  finishTurn(
    id,
    {
      content: result.answer,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
      proposalId: result.proposalId,
      query: result.query,
      agent: { access, steps: result.steps, changes }
    },
    result.cached
  )
  // F-9.10 (agent.v4): the author asked to organise; the plan screen takes it from here, in the
  // chat mode the turn was sent in.
  if (result.organise !== null) void useOrganiseStore.getState().start(result.organise)
  if (messageId === null) return
  // F-5.25 (agent.v8): opening the Library or the upload changes nothing, so it runs in Ask too.
  for (const change of changes) {
    if (isOpenAction(change.edit))
      await useAssistantStore.getState().applyChange(messageId, change.id)
  }
  if (autoApply) {
    const store = useAssistantStore.getState()
    for (const change of changes) {
      if (isDeletion(change.edit) || change.violation !== null || isIntent(change.edit)) continue
      await store.applyChange(messageId, change.id)
    }
  }
  // 2026-10-07: the prose of insertions and rewrites is drafted after the answer, one at a
  // time, and the turn is not held for it: an insertion in Ask waits for the author's Tab.
  void writeIntents(messageId, autoApply)
}

/** Drafts every intent of turn `messageId` still waiting, in order, each after the last settled. */
async function writeIntents(messageId: string, autoApply: boolean): Promise<void> {
  const mine = generation
  const ids = (findMessage(messageId)?.agent?.changes ?? [])
    .filter((change) => change.status === 'pending' && isIntent(change.edit))
    .map((change) => change.id)
  for (const changeId of ids) {
    if (mine !== generation) return
    await writeIntent(messageId, changeId, autoApply)
  }
}

/**
 * Drafts the prose of one intent (2026-10-07). An insertion lands in its scene as ghost text at
 * its anchor (`landDraft`): the card mirrors it (`writing`, then `shown`), Tab or the card's
 * Accept applies it, Escape or Dismiss skips it, and with `autoApply` it is accepted once the
 * draft is in unless the voice check flagged it. A rewrite gets its replacement drafted into the
 * card (`draftReplacement`) and then waits for Apply like any replacement, or is applied at once
 * with `autoApply` unless flagged.
 */
async function writeIntent(messageId: string, changeId: string, autoApply: boolean): Promise<void> {
  const found = findChange(messageId, changeId)
  if (found?.change.status !== 'pending') return
  const { edit } = found.change
  const requestId = nextId('d')
  writing.set(changeId, requestId)
  patchChange(messageId, changeId, { status: 'writing', error: null })
  try {
    if (edit.kind === 'insert') {
      const outcome = await landDraft(
        changeId,
        edit,
        { requestId, autoAccept: autoApply },
        {
          progress: (status, text) => {
            setDraft(changeId, text)
            if (status === 'shown') patchChange(messageId, changeId, { status: 'shown' })
          }
        }
      )
      if (outcome.status === 'failed') {
        patchChange(
          messageId,
          changeId,
          skipped.has(changeId) || outcome.error === null
            ? { status: 'skipped', error: null }
            : { status: 'failed', error: outcome.error }
        )
      } else if (outcome.status === 'rejected') {
        patchChange(messageId, changeId, { status: 'skipped', notice: outcome.notice })
      } else {
        const text = outcome.text
        const { proposalId } = outcome
        undoers.set(changeId, async () =>
          removeInsertedProse(await openEditor(edit.nodeId), text, proposalId)
        )
        patchChange(messageId, changeId, {
          status: 'applied',
          error: null,
          edit: { ...edit, text },
          proposalId: outcome.proposalId,
          notice: outcome.notice
        })
      }
      settleChanges(messageId)
      return
    }
    if (edit.kind !== 'text') return
    const result = await draftReplacement(edit, requestId, (text) => setDraft(changeId, text))
    if (!result.ok) {
      const error = 'error' in result ? result.error : `${result.message} ${result.nextStep}`.trim()
      const stopped = skipped.has(changeId) || ('code' in result && result.code === 'CANCELLED')
      patchChange(
        messageId,
        changeId,
        stopped ? { status: 'skipped', error: null } : { status: 'failed', error }
      )
      settleChanges(messageId)
      return
    }
    if (skipped.has(changeId)) {
      void proposalStore.settle(result.proposalId, 'rejected', null)
      patchChange(messageId, changeId, { status: 'skipped', error: null })
      settleChanges(messageId)
      return
    }
    const violation = result.flagged ? result.violation : null
    patchChange(messageId, changeId, {
      status: 'pending',
      edit: { ...edit, replace: result.text },
      proposalId: result.proposalId,
      violation
    })
    if (autoApply && violation === null) {
      await useAssistantStore.getState().applyChange(messageId, changeId)
    }
  } finally {
    writing.delete(changeId)
    skipped.delete(changeId)
    setDraft(changeId, null)
  }
}

/**
 * F-5.25 (agent.v8): takes back what the latest earlier agent turn of `messageId`'s conversation
 * applied and can still undo (its Undo lives in memory for the session), newest edit first, each
 * marked undone on its turn. Answers null (an undo has no Undo); throws when there is nothing to
 * take back, or with the first undo that fails (what came before it stays undone).
 */
async function undoLastTurn(messageId: string): Promise<null> {
  const conversation = useAssistantStore
    .getState()
    .conversations?.items.find((c) => c.messages.some((m) => m.id === messageId))
  const at = conversation?.messages.findIndex((m) => m.id === messageId) ?? -1
  const earlier = conversation?.messages.slice(0, Math.max(0, at)).reverse() ?? []
  const turn = earlier.find((m) =>
    m.agent?.changes.some((c) => c.status === 'applied' && undoers.has(c.id))
  )
  const changes = (turn?.agent?.changes ?? []).filter(
    (c) => c.status === 'applied' && undoers.has(c.id)
  )
  if (turn === undefined || changes.length === 0) {
    throw new AgentEditError(
      'Nothing from an earlier turn can still be undone here; use Changes or Ctrl+Z'
    )
  }
  for (const change of [...changes].reverse()) {
    const undo = undoers.get(change.id)
    if (undo === undefined) continue
    await undo()
    undoers.delete(change.id)
    patchChange(turn.id, change.id, { status: 'undone', error: null })
  }
  return null
}

/** The message `messageId` in whichever conversation holds it, or null. */
function findMessage(messageId: string): ChatMessage | null {
  for (const conversation of useAssistantStore.getState().conversations?.items ?? []) {
    const message = conversation.messages.find((m) => m.id === messageId)
    if (message) return message
  }
  return null
}

function findChange(
  messageId: string,
  changeId: string
): { message: ChatMessage; change: AgentChange } | null {
  const message = findMessage(messageId)
  const change = message?.agent?.changes.find((c) => c.id === changeId)
  return message && change ? { message, change } : null
}

/** Records where one edit of an agent turn stands. */
function patchChange(
  messageId: string,
  changeId: string,
  patch: Partial<
    Pick<AgentChange, 'status' | 'error' | 'edit' | 'proposalId' | 'violation' | 'notice'>
  >
): void {
  const value = useAssistantStore.getState().conversations
  if (value === null) return
  commit({
    ...value,
    items: value.items.map((conversation) =>
      conversation.messages.some((m) => m.id === messageId)
        ? {
            ...conversation,
            messages: conversation.messages.map((m) =>
              m.id === messageId && m.agent
                ? {
                    ...m,
                    agent: {
                      ...m.agent,
                      changes: m.agent.changes.map((c) =>
                        c.id === changeId ? { ...c, ...patch } : c
                      )
                    }
                  }
                : m
            )
          }
        : conversation
    )
  })
}

function setChanging(changeId: string, on: boolean): void {
  useAssistantStore.setState((s) => {
    const changing = { ...s.changing }
    if (on) changing[changeId] = true
    else delete changing[changeId]
    return { changing }
  })
}

/**
 * Settles an agent turn's proposal (F-14.5) once none of its edits waits any longer: every edit
 * applied is `accepted`, some `acceptedPart`, none `rejected`. A turn without edits stays
 * pending, as an answer that changed nothing does.
 */
function settleChanges(messageId: string): void {
  const message = findMessage(messageId)
  const changes = message?.agent?.changes ?? []
  if (message?.proposalId == null || changes.length === 0) return
  if (changes.some((c) => c.status === 'pending')) return
  const applied = changes.filter((c) => c.status === 'applied' || c.status === 'undone').length
  const status = applied === changes.length ? 'accepted' : applied > 0 ? 'acceptedPart' : 'rejected'
  void proposalStore.settle(message.proposalId, status, null)
}

/**
 * A failed, stopped, or abandoned turn: the unanswered turn leaves the chat, the request is no
 * longer pending, and the reason toasts (none for a cancellation, which the author chose).
 */
function settleFailure(id: string, requestId: string, message: string | null): void {
  const { pending, conversations } = useAssistantStore.getState()
  if (pending[id] !== requestId) return
  setPending(id, null)
  if (conversations !== null) commit(dropUnanswered(conversations, id))
  if (message !== null) toast.error(message)
}

/** The active conversation, or null before the load or without one. */
export function useActiveConversation(): Conversation | null {
  return useAssistantStore((s) => {
    const value = s.conversations
    if (value?.active == null) return null
    return value.items.find((c) => c.id === value.active) ?? null
  })
}

/** Drops the timer, the revert baseline, the subscriptions, and the state. For tests only. */
export function resetAssistantStore(): void {
  useAssistantStore.getState().clear()
}
