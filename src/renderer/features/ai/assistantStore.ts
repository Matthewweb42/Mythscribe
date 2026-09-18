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
import type { AiChatResult, AiQueryResult, Input } from '@shared/ipc/contract'
import type { QuerySceneRef } from '@shared/query'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import {
  useActiveEditorStore,
  type ActiveEditor
} from '@renderer/features/editor/activeEditorStore'
import type { GhostSettleHandler } from '@renderer/features/editor/ghostText'
import { locateText } from '@renderer/features/editor/locateText'
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
/** The toast when Author mode came back with nothing to place. */
export const EMPTY_ANSWER_MESSAGE = 'The assistant returned no text. Try again.'
/** The toast when a Query citation names a passage the scene no longer holds (F-5.7). */
export const PASSAGE_GONE_MESSAGE = 'That passage is no longer in the scene'
/** How long `openScene` waits for the scene it selected to mount its editor. */
export const OPEN_SCENE_TIMEOUT_MS = 3_000

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
  /** Sends one turn in the active conversation; ignored while one is in flight or for a blank message. */
  send: (message: string) => Promise<void>
  /** Stops the active conversation's request in flight: the unanswered turn goes, the author's turn stays. */
  stop: () => void
  /**
   * Opens the scene a Query citation names (F-5.7) and, with a quote, selects that passage in
   * it. A quote the scene no longer holds toasts; a null quote just opens the scene.
   */
  openScene: (ref: QuerySceneRef, quote: string | null) => Promise<void>
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
  mode,
  query: null
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

  async send(message) {
    const value = get().conversations
    const text = message.trim().slice(0, CHAT_MESSAGE_MAX)
    if (value?.active == null || !text) return
    const id = value.active
    const conversation = value.items.find((c) => c.id === id)
    if (!conversation || get().pending[id] !== undefined) return
    const { mode, paragraphs } = conversation
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
      await sendQuery(id, { nodeId, message: text, history, requestId })
      return
    }
    let result: AiChatResult
    try {
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
    setPending(id, null)
    const current = get().conversations
    if (current === null) return
    const turnId = current.items.find((c) => c.id === id)?.messages.at(-1)?.id ?? null
    commit(
      patchOne(current, id, (c) => {
        const last = c.messages[c.messages.length - 1]
        if (last?.role !== 'assistant') return c
        return {
          ...c,
          messages: [
            ...c.messages.slice(0, -1),
            {
              ...last,
              content: result.text,
              model: result.model,
              costUsd: result.costUsd,
              proposalId: result.proposalId
            }
          ]
        }
      })
    )
    if (result.cached && turnId !== null) {
      set((s) => ({ cached: { ...s.cached, [turnId]: true } }))
    }
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
    // The tree's selection drives the editor pane, so selecting the node opens the scene.
    useTreeStore.getState().select(ref.nodeId)
    if (quote === null) return
    const editor = await editorFor(ref.nodeId)
    if (editor === null || editor.isDestroyed) return
    const range = locateText(editor.state.doc, quote)
    if (range === null) {
      toast.error(PASSAGE_GONE_MESSAGE)
      return
    }
    editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  }
}))

/**
 * The live editor of `nodeId`: the one already registered, or the one the scene mounts after
 * the selection changed. Null when none arrives within `OPEN_SCENE_TIMEOUT_MS` (the scene is
 * open all the same; only the passage cannot be selected).
 */
function editorFor(nodeId: string): Promise<Editor | null> {
  const liveOne = (active: ActiveEditor | null): Editor | null =>
    active !== null && active.id === nodeId && !active.editor.isDestroyed ? active.editor : null
  const current = liveOne(useActiveEditorStore.getState().active)
  if (current !== null) return Promise.resolve(current)
  return new Promise((resolve) => {
    let stopWatching: (() => void) | null = null
    const settle = (editor: Editor | null): void => {
      clearTimeout(waiting)
      stopWatching?.()
      resolve(editor)
    }
    const waiting = setTimeout(() => settle(null), OPEN_SCENE_TIMEOUT_MS)
    stopWatching = useActiveEditorStore.subscribe((state) => {
      const editor = liveOne(state.active)
      if (editor !== null) settle(editor)
    })
  })
}

/**
 * One Query turn (F-5.7): main ranks the manuscript's scenes, answers with the citations it
 * verified, and the answer lands whole in the chat (nothing streams, nothing enters the
 * manuscript). Failures settle exactly as a Plan turn's do.
 */
async function sendQuery(id: string, input: Input<'ai:query'>): Promise<void> {
  const { requestId } = input
  let result: AiQueryResult
  try {
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
  setPending(id, null)
  const current = useAssistantStore.getState().conversations
  if (current === null) return
  const turnId = current.items.find((c) => c.id === id)?.messages.at(-1)?.id ?? null
  commit(
    patchOne(current, id, (c) => {
      const last = c.messages[c.messages.length - 1]
      if (last?.role !== 'assistant') return c
      return {
        ...c,
        messages: [
          ...c.messages.slice(0, -1),
          {
            ...last,
            content: result.answer,
            model: result.model,
            costUsd: result.costUsd,
            proposalId: result.proposalId,
            query: {
              found: result.found,
              uncited: result.uncited,
              citations: result.citations,
              also: result.also
            }
          }
        ]
      }
    })
  )
  if (result.cached && turnId !== null) {
    useAssistantStore.setState((s) => ({ cached: { ...s.cached, [turnId]: true } }))
  }
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
