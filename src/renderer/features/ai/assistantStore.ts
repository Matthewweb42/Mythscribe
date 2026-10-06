import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MAX_CONVERSATIONS,
  CHAT_MAX_MESSAGES,
  CHAT_MESSAGE_MAX,
  CHAT_PARAGRAPHS_DEFAULT,
  Conversations,
  titleFor,
  type ChatMessage,
  type ChatMode,
  type Conversation
} from '@shared/chat'
import type { AiChatResult, AiQueryResult, AiWhatNextResult, Input } from '@shared/ipc/contract'
import type { QuerySceneRef } from '@shared/query'
import { WHAT_NEXT_QUESTION, directionMessage, recapQuestion } from '@shared/quickActions'
import { WHAT_NEXT_CHAR_BUDGET, directionsText, type WhatNextDirection } from '@shared/whatNext'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import {
  useActiveEditorStore,
  type ActiveEditor
} from '@renderer/features/editor/activeEditorStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import type { GhostSettleHandler } from '@renderer/features/editor/ghostText'
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
import { useAiActivityStore } from './aiActivityStore'
import { proposalStore } from './proposalStore'

/** The title of a conversation nobody has written in yet. */
export const NEW_CONVERSATION_TITLE = 'New conversation'
/** The turn the chat shows for an Author-mode answer, whose text went to the editor instead. */
export const AGENT_NOTICE = 'Placed in the editor. Tab accepts, Escape dismisses.'
/** The toast when Author mode has no document editor to place its answer in. */
export const NO_EDITOR_MESSAGE = 'Open a scene to place text'
/** The toast when What should come next? has no open scene to read (F-5.17). */
export const NO_SCENE_MESSAGE = 'Open a scene first'
/** The toast when Author mode came back with nothing to place. */
export const EMPTY_ANSWER_MESSAGE = 'The assistant returned no text. Try again.'
// The passage jump lives in the editor feature (F-4.12 reuses it for mentions); the two
// constants are re-exported here because the Query panel and this store's tests read them.
export { OPEN_SCENE_TIMEOUT_MS, PASSAGE_GONE_MESSAGE }

/**
 * The one owner of the project's assistant conversations (F-5.4): the tabs, the open one,
 * every turn, and which conversations have a request in flight. Persistence is the
 * `presetsStore` pattern: every change applies at once and is written after the shared
 * debounce through `conversations:set`; a failed write reverts to the last persisted value and
 * toasts; the pending-save registry flushes it before the project closes. Main is stateless
 * about conversations: `send` carries the recent turns as `history`, appends the streamed
 * `ai:chatDelta` pieces of a Plan answer to the turn they belong to, and fills the turn with
 * the model, cost, and proposal id when the request resolves. An Author answer never enters the
 * chat: it goes to the active editor as ghost text (F-5.3), marked with its proposal on accept
 * (F-14.6) and settled through the ghost's own exit (F-14.5); the chat records a notice turn.
 * A Query answer (F-5.7) comes back whole, not streamed, and rides on its turn as `query`: the
 * citations main verified, the ranked scenes it did not cite, and the two flags the panel
 * shows; `openScene` opens a cited scene and selects the passage.
 * The quick actions (F-5.17) write into the active conversation through the same turns:
 * `recap` is a Query turn with a fixed question that pins the open scene first, `whatNext`
 * asks `ai:whatNext` and records the directions on the assistant turn, and `writeDirection`
 * sends one of them as an Author turn, so it lands as ghost text. One busy rule covers them
 * all: nothing new starts while the active conversation has a request in flight.
 * Every request is tracked in the activity store and can be stopped (F-5.10): `stop` drops the
 * unanswered turn (with whatever streamed into it) and keeps the author's turn to resend; the
 * `CANCELLED` reply is silent. Loaded with the tree on project open and cleared on close
 * (`App.tsx`).
 */
interface AssistantState {
  /** The loaded conversations; null until `load` resolves (the panel renders its chrome disabled until then). */
  conversations: Conversations | null
  /** Conversation id → the request id of its turn in flight. */
  pending: Record<string, string>
  /** Message ids answered from the local cache this session (the cost line says so; not persisted). */
  cached: Record<string, true>
  load: () => Promise<void>
  /** Cancels any pending write, drops the delta subscription, and empties the store. */
  clear: () => void
  /** Opens a fresh Plan conversation as the active tab; a no-op at the conversation cap. */
  newConversation: () => void
  /** Drops a conversation (its request in flight is stopped); the last tab is replaced by a fresh one. */
  closeConversation: (id: string) => void
  select: (id: string) => void
  setMode: (mode: ChatMode) => void
  setParagraphs: (paragraphs: number) => void
  /** Empties the active conversation's turns and resets its title. */
  clearMessages: () => void
  /**
   * Sends one turn in the active conversation; ignored while one is in flight or for a blank
   * message. `override.mode` runs this turn in another mode than the conversation's (the
   * conversation keeps its own); `override.pinActive` asks a Query turn to rank the open scene
   * first (F-5.17).
   */
  send: (message: string, override?: SendOverride) => Promise<void>
  /**
   * What should come next? (F-5.17): three directions for the open scene, as a turn in the
   * active conversation. With a selection the text up to its end goes along; without one the
   * autosave is flushed and main reads the saved scene.
   */
  whatNext: () => Promise<void>
  /** What happened here? (F-5.17): a cited recap of the open scene, or of the selection, as a Query turn. */
  recap: () => Promise<void>
  /** Write this (F-5.17): sends a direction as an Author turn, so the text lands as ghost text. */
  writeDirection: (direction: WhatNextDirection) => Promise<void>
  /** Stops the active conversation's request in flight: the unanswered turn goes, the author's turn stays. */
  stop: () => void
  /**
   * Opens the scene a Query citation names (F-5.7) and, with a quote, selects that passage in
   * it. A quote the scene no longer holds toasts; a null quote just opens the scene.
   */
  openScene: (ref: QuerySceneRef, quote: string | null) => Promise<void>
}

/** A turn sent in another mode than its conversation's, or a Query turn pinned to the open scene. */
export interface SendOverride {
  mode?: ChatMode
  pinActive?: boolean
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: Conversations | null = null
/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
let unregister: (() => void) | null = null
let unsubscribe: (() => void) | null = null
let counter = 0

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
    mode: 'query',
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
  directions: null
})

/** `value` with the active conversation replaced by `patch(conversation)`, its `modified` bumped. */
function patchActive(
  value: Conversations,
  patch: (conversation: Conversation) => Conversation
): Conversations {
  return patchOne(value, value.active, patch)
}

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

/** Appends a streamed piece to the assistant turn at the end of the conversation the request belongs to. */
function onDelta({ requestId, delta }: { requestId: string; delta: string }): void {
  const id = conversationOfRequest(requestId)
  const value = useAssistantStore.getState().conversations
  if (id === null || value === null) return
  commit(
    patchOne(value, id, (c) => {
      const last = c.messages[c.messages.length - 1]
      if (last?.role !== 'assistant') return c
      return {
        ...c,
        messages: [...c.messages.slice(0, -1), { ...last, content: last.content + delta }]
      }
    })
  )
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
 * of the conversation, streamed pieces included: only a resolved request fills in the model.
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

/**
 * Places an Agent answer in the active editor as ghost text carrying its proposal, and settles
 * that proposal once through the ghost's exit: the hook slot belongs to the ghost-text
 * controller (F-5.3) while its session runs, so this wraps whatever is there for exactly one
 * settlement and restores it. Installed after `setGhost` ran, so a suggestion this one replaced
 * settled under its own listener first. False when no editor can take the text.
 */
function placeInEditor(result: Extract<AiChatResult, { ok: true }>): boolean {
  const active = useActiveEditorStore.getState().active
  if (active === null || active.editor.isDestroyed) return false
  const { editor } = active
  const shown = editor
    .chain()
    .focus()
    .setGhost(result.text, result.flagged, result.violation, result.proposalId)
    .run()
  if (!shown) return false
  const storage = editor.storage.ghostText
  if (!storage) return true
  const previous = storage.onSettle
  const settleOnce: GhostSettleHandler = (status, consumed) => {
    if (storage.onSettle === settleOnce) storage.onSettle = previous
    void proposalStore.settle(result.proposalId, status, null)
    previous?.(status, consumed)
  }
  storage.onSettle = settleOnce
  return true
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  conversations: null,
  pending: {},
  cached: {},

  async load() {
    unregister ??= registerPendingSave(flush)
    unsubscribe ??= ipc().on('ai:chatDelta', onDelta)
    const mine = ++generation
    const value = await ipc().invoke('conversations:get', undefined)
    if (mine !== generation) return
    // A fresh project gets an in-memory conversation to write in; it is persisted with its first change.
    set({ conversations: withOne(value) })
  },

  clear() {
    generation++
    cancelTimer()
    persisted = null
    unregister?.()
    unregister = null
    unsubscribe?.()
    unsubscribe = null
    set({ conversations: null, pending: {}, cached: {} })
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

  setMode(mode) {
    const value = get().conversations
    if (value === null) return
    commit(patchActive(value, (c) => (c.mode === mode ? c : { ...c, mode })))
  },

  setParagraphs(paragraphs) {
    const value = get().conversations
    if (value === null) return
    commit(patchActive(value, (c) => (c.paragraphs === paragraphs ? c : { ...c, paragraphs })))
  },

  clearMessages() {
    const value = get().conversations
    if (value === null) return
    commit(patchActive(value, (c) => ({ ...c, title: NEW_CONVERSATION_TITLE, messages: [] })))
  },

  async send(message, override) {
    const value = get().conversations
    const text = message.trim().slice(0, CHAT_MESSAGE_MAX)
    if (value?.active == null || !text) return
    const id = value.active
    const conversation = value.items.find((c) => c.id === id)
    if (!conversation || get().pending[id] !== undefined) return
    const mode = override?.mode ?? conversation.mode
    const { paragraphs } = conversation
    if (mode === 'agent' && useActiveEditorStore.getState().active === null) {
      toast.error(NO_EDITOR_MESSAGE)
      return
    }
    const history = conversation.messages
      .filter((m) => m.content !== '')
      .slice(-CHAT_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }))
    const requestId = nextId('r')
    setPending(id, requestId)
    commit(
      patchOne(value, id, (c) => ({
        ...c,
        title: c.messages.length === 0 ? titleFor(text) || NEW_CONVERSATION_TITLE : c.title,
        messages: [...c.messages, turn('user', text, null), turn('assistant', '', mode)].slice(
          -CHAT_MAX_MESSAGES
        )
      }))
    )
    const nodeId = useActiveEditorStore.getState().active?.id ?? null
    if (mode === 'query') {
      await sendQuery(id, {
        nodeId,
        message: text,
        history,
        requestId,
        ...(override?.pinActive === true ? { pinActive: true } : {})
      })
      return
    }
    let result: AiChatResult
    try {
      // Main reads the saved scene: the words typed just before asking go first.
      await useDocumentStore.getState().flush()
      if (get().pending[id] !== requestId) return // stopped or closed while saving
      result = await useAiActivityStore.getState().track(
        'chat',
        requestId,
        ipc().invoke('ai:chat', {
          nodeId,
          mode,
          paragraphs,
          message: text,
          history,
          requestId
        })
      )
    } catch (err) {
      settleFailure(id, requestId, describeError(err))
      return
    }
    if (get().pending[id] !== requestId) {
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
    if (mode === 'agent' && !result.text.trim()) {
      void proposalStore.settle(result.proposalId, 'rejected', null)
      settleFailure(id, requestId, EMPTY_ANSWER_MESSAGE)
      return
    }
    if (mode === 'agent' && !placeInEditor(result)) {
      void proposalStore.settle(result.proposalId, 'rejected', null)
      settleFailure(id, requestId, NO_EDITOR_MESSAGE)
      return
    }
    finishTurn(
      id,
      {
        content: result.text,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        proposalId: result.proposalId
      },
      result.cached
    )
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
    const { editor } = active
    const nodeId = active.id
    // With a selection the directions follow from the text up to its end; the contract caps it.
    const before = editor.state.selection.empty
      ? null
      : editor.state.doc
          .textBetween(0, editor.state.selection.to, '\n\n')
          .slice(-WHAT_NEXT_CHAR_BUDGET)
    const requestId = nextId('r')
    setPending(id, requestId)
    commit(
      patchOne(value, id, (c) => ({
        ...c,
        title: c.messages.length === 0 ? titleFor(WHAT_NEXT_QUESTION) : c.title,
        messages: [
          ...c.messages,
          turn('user', WHAT_NEXT_QUESTION, null),
          turn('assistant', '', 'plan')
        ].slice(-CHAT_MAX_MESSAGES)
      }))
    )
    let result: AiWhatNextResult
    try {
      // Main reads the saved scene when no selection rides along: the author's typing goes first.
      await useDocumentStore.getState().flush()
      if (get().pending[id] !== requestId) return // stopped or closed while saving
      result = await useAiActivityStore
        .getState()
        .track('whatNext', requestId, ipc().invoke('ai:whatNext', { nodeId, requestId, before }))
    } catch (err) {
      settleFailure(id, requestId, describeError(err))
      return
    }
    if (get().pending[id] !== requestId) {
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
  },

  async recap() {
    const active = liveEditor()
    const selection = active === null ? null : selectedText(active.editor)
    await get().send(recapQuestion(selection), { mode: 'query', pinActive: true })
  },

  async writeDirection(direction) {
    await get().send(directionMessage(direction), { mode: 'agent' })
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

/**
 * One Query turn (F-5.7): main ranks the manuscript's scenes, answers with the citations it
 * verified, and the answer lands whole in the chat (nothing streams, nothing enters the
 * manuscript). Failures settle exactly as a Plan turn's do.
 */
async function sendQuery(id: string, input: Input<'ai:query'>): Promise<void> {
  const { requestId } = input
  let result: AiQueryResult
  try {
    // Main searches the saved manuscript: the words typed just before asking go first.
    await useDocumentStore.getState().flush()
    if (useAssistantStore.getState().pending[id] !== requestId) return // stopped while saving
    result = await useAiActivityStore
      .getState()
      .track('query', requestId, ipc().invoke('ai:query', input))
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
      content: result.answer,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
      proposalId: result.proposalId,
      query: {
        found: result.found,
        uncited: result.uncited,
        citations: result.citations,
        sheets: result.sheets,
        also: result.also
      }
    },
    result.cached
  )
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
