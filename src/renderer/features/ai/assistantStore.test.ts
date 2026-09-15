import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MAX_CONVERSATIONS,
  titleFor,
  type Conversation,
  type Conversations
} from '@shared/chat'
import type {
  AiChatResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { ghostOf, type GhostSettleHandler } from '@renderer/features/editor/ghostText'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { flushPendingSaves, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  AGENT_NOTICE,
  EMPTY_ANSWER_MESSAGE,
  NEW_CONVERSATION_TITLE,
  NO_EDITOR_MESSAGE,
  resetAssistantStore,
  useAssistantStore
} from './assistantStore'
import { resetAiActivityStore, useAiActivityStore } from './aiActivityStore'
import { resetProposalStore } from './proposalStore'

interface PendingSet {
  value: Conversations
  resolve: () => void
  reject: (err: Error) => void
}
interface PendingChat {
  input: Input<'ai:chat'>
  resolve: (result: AiChatResult) => void
  reject: (err: Error) => void
}

let sets: PendingSet[]
let chats: PendingChat[]
let settles: Input<'proposal:settle'>[]
/** The request ids `ai:cancel` was asked to stop. */
let cancels: string[]
/** The `ai:chatDelta` listener the store registered, if any. */
let deltaListener: ((payload: EventPayload<'ai:chatDelta'>) => void) | null
let unsubscribed: number

/**
 * `conversations:get` answers with `stored`; `conversations:set` and `ai:chat` resolve only when
 * the test says so; `proposal:settle` records; the delta event listener is captured.
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
      if (channel === 'ai:chat') {
        return new Promise<Output<C>>((resolve, reject) => {
          chats.push({
            input: input as Input<'ai:chat'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'proposal:settle') {
        settles.push(input as Input<'proposal:settle'>)
        return null as Output<C>
      }
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: true } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      if (event === 'ai:chatDelta') {
        deltaListener = listener as (payload: EventPayload<'ai:chatDelta'>) => void
      }
      return () => {
        unsubscribed++
        deltaListener = null
      }
    }
  }
}

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
      mode: null
    },
    {
      id: 'm-2',
      role: 'assistant',
      content: 'Because Mara wants the view.',
      created: '2026-09-15T10:00:01.000Z',
      proposalId: 'p-1',
      model: 'gpt-fake',
      costUsd: 0.0002,
      mode: 'plan'
    }
  ],
  created: '2026-09-15T10:00:00.000Z',
  modified: '2026-09-15T10:00:01.000Z',
  ...over
})

const STORED: Conversations = { active: 'c-1', items: [conversation()] }

type ChatOk = Extract<AiChatResult, { ok: true }>

const ok = (requestId: string, text: string, over: Partial<ChatOk> = {}): AiChatResult => ({
  ok: true,
  text,
  usage: { inputTokens: 200, outputTokens: 40 },
  costUsd: 0.0003,
  cached: false,
  model: 'gpt-fake',
  flagged: false,
  violation: null,
  proposalId: `prop-${requestId}`,
  requestId,
  ...over
})

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

/** Sends `text` in the loaded state and hands back the request main received. */
async function sendAndCapture(text: string): Promise<PendingChat> {
  const sending = store().send(text)
  await settle()
  const request = chats[chats.length - 1]
  if (!request) throw new Error('nothing was sent')
  return Object.assign(request, { done: sending })
}

beforeEach(() => {
  vi.useFakeTimers()
  sets = []
  chats = []
  settles = []
  cancels = []
  deltaListener = null
  unsubscribed = 0
  resetAssistantStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  resetProposalStore()
  resetPendingSaves()
  resetTagStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(deferredClient(STORED))
})
afterEach(() => {
  resetAssistantStore()
  resetActiveEditorStore()
  resetAiActivityStore()
  vi.useRealTimers()
})

describe('useAssistantStore load and persistence (F-5.4)', () => {
  it('starts empty, loads the stored conversations, and subscribes to the deltas', async () => {
    expect(store().conversations).toBeNull()
    expect(deltaListener).toBeNull()
    await store().load()
    expect(store().conversations).toEqual(STORED)
    expect(deltaListener).not.toBeNull()
    expect(sets).toHaveLength(0)
  })

  it('gives a fresh project one Plan conversation to write in without writing it', async () => {
    setIpcClient(deferredClient({ active: null, items: [] }))
    await store().load()
    const value = store().conversations
    expect(value?.items).toHaveLength(1)
    expect(value?.active).toBe(value?.items[0]?.id)
    expect(value?.items[0]).toMatchObject({
      title: NEW_CONVERSATION_TITLE,
      mode: 'plan',
      paragraphs: 1,
      messages: []
    })
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('repairs a stored active id that names no conversation', async () => {
    setIpcClient(deferredClient({ active: 'gone', items: [conversation()] }))
    await store().load()
    expect(store().conversations?.active).toBe('c-1')
  })

  it('applies a mode change at once and writes it once after the debounce', async () => {
    await store().load()
    store().setMode('agent')
    store().setParagraphs(3)
    expect(active()).toMatchObject({ mode: 'agent', paragraphs: 3 })
    expect(sets).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items[0]).toMatchObject({ mode: 'agent', paragraphs: 3 })
    sets[0]?.resolve()
    await settle()
    expect(active().mode).toBe('agent')
  })

  it('reverts to the value before a failed write and toasts', async () => {
    await store().load()
    store().setMode('agent')
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    sets[0]?.reject(new Error('disk full'))
    await settle()
    expect(active().mode).toBe('plan')
    expect(toasts()).toEqual(['disk full'])
  })

  it('writes a pending change when the pending saves are flushed (project close)', async () => {
    await store().load()
    store().clearMessages()
    const flushing = flushPendingSaves()
    await settle()
    expect(sets).toHaveLength(1)
    expect(sets[0]?.value.items[0]).toMatchObject({ title: NEW_CONVERSATION_TITLE, messages: [] })
    sets[0]?.resolve()
    await flushing
  })

  it('clear empties the store, cancels the pending write, and drops the delta subscription', async () => {
    await store().load()
    store().setMode('agent')
    store().clear()
    expect(store().conversations).toBeNull()
    expect(unsubscribed).toBe(1)
    expect(deltaListener).toBeNull()
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS)
    expect(sets).toHaveLength(0)
  })

  it('ignores changes before anything is loaded', async () => {
    store().setMode('agent')
    store().newConversation()
    await store().send('hello')
    expect(store().conversations).toBeNull()
    expect(chats).toHaveLength(0)
  })
})

describe('useAssistantStore tabs (F-5.4)', () => {
  it('newConversation opens a fresh Plan tab as the active one, up to the cap', async () => {
    await store().load()
    store().newConversation()
    const value = store().conversations
    expect(value?.items).toHaveLength(2)
    expect(value?.active).toBe(value?.items[1]?.id)
    expect(active()).toMatchObject({ title: NEW_CONVERSATION_TITLE, mode: 'plan', messages: [] })
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

  it('clearMessages empties the active conversation and resets its title', async () => {
    await store().load()
    store().clearMessages()
    expect(active()).toMatchObject({ title: NEW_CONVERSATION_TITLE, messages: [] })
  })
})

describe('useAssistantStore send, Plan mode (F-5.4)', () => {
  it('appends the turn and an empty answer, sends the recent history, streams the deltas, then fills the answer with its cost', async () => {
    await store().load()
    const request = await sendAndCapture('  What does Mara want?  ')
    expect(request.input).toEqual({
      nodeId: null,
      mode: 'plan',
      paragraphs: 1,
      message: 'What does Mara want?',
      history: [
        { role: 'user', content: 'Why the ridge?' },
        { role: 'assistant', content: 'Because Mara wants the view.' }
      ],
      requestId: expect.any(String) as string
    })
    expect(active().messages).toHaveLength(4)
    expect(active().messages[2]).toMatchObject({ role: 'user', content: 'What does Mara want?' })
    expect(active().messages[3]).toMatchObject({ role: 'assistant', content: '', mode: 'plan' })
    expect(store().pending['c-1']).toBe(request.input.requestId)

    deltaListener?.({ requestId: request.input.requestId, delta: 'The ' })
    deltaListener?.({ requestId: request.input.requestId, delta: 'view.' })
    deltaListener?.({ requestId: 'someone-else', delta: 'noise' })
    expect(active().messages[3]?.content).toBe('The view.')

    request.resolve(ok(request.input.requestId, 'The view.', { cached: true }))
    await settle()
    expect(store().pending).toEqual({})
    const answer = active().messages[3]
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'The view.',
      model: 'gpt-fake',
      costUsd: 0.0003,
      proposalId: `prop-${request.input.requestId}`,
      mode: 'plan'
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
      mode: null
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

    setIpcClient(deferredClient({ active: 'c-1', items: [conversation({ messages: [] })] }))
    resetAssistantStore()
    chats = []
    await store().load()
    const long = 'A question that runs well past the forty-character title cap'
    const first = await sendAndCapture(long)
    expect(first.input.history).toEqual([])
    expect(active().title).toBe(titleFor(long))
    expect(active().title.endsWith('…')).toBe(true)
  })

  it('ignores a blank message and a second send while one is in flight', async () => {
    await store().load()
    await store().send('   ')
    expect(chats).toHaveLength(0)
    const sending = store().send('one')
    await settle()
    await store().send('two')
    expect(chats).toHaveLength(1)
    expect(active().messages).toHaveLength(4)
    chats[0]?.resolve(ok(chats[0].input.requestId, 'answer'))
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
    const request = chats[0]
    request?.resolve(ok(request.input.requestId, 'late'))
    await sending
    expect(store().conversations?.items.map((c) => c.id)).toEqual(['c-1'])
    expect(settles).toEqual([
      { id: `prop-${request?.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(toasts()).toEqual([])
  })
})

describe('useAssistantStore stop (F-5.10)', () => {
  const cancelled = (requestId: string): AiChatResult => ({
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
      [request.input.requestId]: { feature: 'chat', startedAt: expect.any(Number) as number }
    })
    request.resolve(ok(request.input.requestId, 'answer'))
    await settle()
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('stop drops the unanswered turn with what streamed into it, keeps the author’s turn, asks main to stop, and the reply is silent', async () => {
    await store().load()
    const request = await sendAndCapture('What next?')
    deltaListener?.({ requestId: request.input.requestId, delta: 'The ' })
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
    again.resolve(ok(again.input.requestId, 'She climbs.'))
    await settle()
    expect(active().messages[4]?.content).toBe('She climbs.')
  })

  it('stop is a no-op without a request in flight, and a late answer for a stopped request only rejects its proposal', async () => {
    await store().load()
    store().stop()
    expect(cancels).toEqual([])
    const request = await sendAndCapture('hello')
    store().stop()
    request.resolve(ok(request.input.requestId, 'late'))
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
    expect(cancels).toEqual([chats[0]?.input.requestId])
    chats[0]?.resolve(cancelled(chats[0].input.requestId))
    await sending
    expect(toasts()).toEqual([])
  })
})

describe('useAssistantStore send, Agent mode (F-5.4)', () => {
  const CONTENT = 'The storm broke at dusk.'
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: CONTENT }] }]
      }
    })
    editor.commands.focus('end')
  })
  afterEach(() => {
    editor.destroy()
  })

  const press = (key: string): void => {
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    )
  }

  it('refuses to send without an active editor', async () => {
    await store().load()
    store().setMode('agent')
    await store().send('continue')
    expect(chats).toHaveLength(0)
    expect(toasts()).toEqual([NO_EDITOR_MESSAGE])
    expect(active().messages).toHaveLength(2)
  })

  it('sends the active editor as the scene, places the answer as ghost text with its proposal, and records the notice turn', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    store().setMode('agent')
    store().setParagraphs(2)
    const request = await sendAndCapture('continue')
    expect(request.input).toMatchObject({ nodeId: 'sc-1', mode: 'agent', paragraphs: 2 })
    request.resolve(
      ok(request.input.requestId, ' Rain followed.\n\nThen silence.', {
        flagged: true,
        violation: 'switches to present tense'
      })
    )
    await settle()
    expect(ghostOf(editor.state)).toMatchObject({
      text: ' Rain followed.\n\nThen silence.',
      flagged: true,
      violation: 'switches to present tense',
      proposalId: `prop-${request.input.requestId}`
    })
    const answer = active().messages[3]
    expect(answer).toMatchObject({
      role: 'assistant',
      mode: 'agent',
      content: ' Rain followed.\n\nThen silence.',
      model: 'gpt-fake',
      proposalId: `prop-${request.input.requestId}`
    })
    expect(AGENT_NOTICE).toContain('Tab')
    expect(toasts()).toEqual([])

    // Tab accepts: the proposal settles once through the ghost's exit, the text lands marked.
    press('Tab')
    expect(settles).toEqual([
      { id: `prop-${request.input.requestId}`, status: 'accepted', note: null }
    ])
    expect(editor.getText()).toBe(`${CONTENT} Rain followed.\n\nThen silence.`)
    expect(editor.getJSON().content).toHaveLength(2)
    // The hook slot is back to what it was (nobody was listening), so the next ghost settles nothing here.
    expect(editor.storage.ghostText?.onSettle).toBeNull()
  })

  it('hands the settlement on to the ghost-text controller listener that was there and restores it', async () => {
    const previous = vi.fn<GhostSettleHandler>()
    if (editor.storage.ghostText) editor.storage.ghostText.onSettle = previous
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    store().setMode('agent')
    const request = await sendAndCapture('continue')
    request.resolve(ok(request.input.requestId, ' Rain followed.'))
    await settle()
    press('Escape')
    expect(settles).toEqual([
      { id: `prop-${request.input.requestId}`, status: 'rejected', note: null }
    ])
    expect(previous).toHaveBeenCalledExactlyOnceWith('rejected', '')
    expect(editor.storage.ghostText?.onSettle).toBe(previous)
  })

  it('rejects the proposal and toasts when the editor went away before the answer, or the answer is empty', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await store().load()
    store().setMode('agent')
    const request = await sendAndCapture('continue')
    resetActiveEditorStore()
    request.resolve(ok(request.input.requestId, ' Rain followed.'))
    await settle()
    expect(ghostOf(editor.state)).toBeNull()
    expect(active().messages).toHaveLength(3)
    expect(toasts()).toEqual([NO_EDITOR_MESSAGE])
    expect(settles).toEqual([
      { id: `prop-${request.input.requestId}`, status: 'rejected', note: null }
    ])

    useActiveEditorStore.getState().set('sc-1', editor)
    chats = []
    const again = await sendAndCapture('continue')
    again.resolve(ok(again.input.requestId, '   '))
    await settle()
    expect(ghostOf(editor.state)).toBeNull()
    expect(toasts()).toEqual([NO_EDITOR_MESSAGE, EMPTY_ANSWER_MESSAGE])
    expect(settles).toHaveLength(2)
  })
})
