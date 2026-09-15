import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AiRewriteResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { buildExtensions } from './extensions'
import { rewriteTargetOf } from './rewriteTarget'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingRewrite {
  input: Input<'ai:rewrite'>
  resolve: (result: AiRewriteResult) => void
  reject: (err: Error) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const FIRST_END = FIRST.length + 1
const SECOND = 'Nobody answered him.'
const ANSWER = 'The storm came down at dusk. Rain came after.'

let editor: Editor
let requests: PendingRewrite[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]
let deltaListener: ((payload: EventPayload<'ai:rewriteDelta'>) => void) | null

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:rewrite') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:rewrite'>,
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
      if (event === 'ai:rewriteDelta') {
        deltaListener = listener as (payload: EventPayload<'ai:rewriteDelta'>) => void
      }
      return () => {
        deltaListener = null
      }
    }
  }
}

const ok = (requestId: string, over: Partial<Extract<AiRewriteResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    text: ANSWER,
    usage: { inputTokens: 300, outputTokens: 20 },
    costUsd: 0.0002,
    cached: false,
    model: 'gpt-5.4-mini',
    flagged: false,
    violation: null,
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiRewriteResult

const session = () => useRewriteStore.getState().session
const store = () => useRewriteStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** Each paragraph's text; a tag token or a hard break reads as nothing. */
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}

/** Selects the first paragraph and starts a rewrite for it; hands back the request. */
async function startFirst(): Promise<PendingRewrite> {
  editor.commands.setTextSelection({ from: 1, to: FIRST_END })
  store().start('sc-1', editor)
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

/** Starts and resolves a rewrite so the session is `ready`. */
async function ready(): Promise<PendingRewrite> {
  const request = await startFirst()
  request.resolve(ok(request.input.requestId))
  await flush()
  expect(session()?.status).toBe('ready')
  return request
}

beforeEach(() => {
  resetTagStore()
  resetRewriteStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
  deltaListener = null
  setIpcClient(fakeClient())
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        { type: 'paragraph', content: [{ type: 'text', text: SECOND }] }
      ]
    }
  })
})
afterEach(() => {
  resetRewriteStore()
  resetAiActivityStore()
  resetProposalStore()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('rewriteStore (F-14.10)', () => {
  it('start captures the passage and its context, sets the target, tracks the request, and streams the draft', async () => {
    const request = await startFirst()
    expect(request.input).toEqual({
      nodeId: 'sc-1',
      from: 1,
      to: FIRST_END,
      text: FIRST,
      before: '',
      after: `\n\n${SECOND}`,
      requestId: expect.stringMatching(/^rw-/) as string
    })
    expect(session()).toMatchObject({
      nodeId: 'sc-1',
      requestId: request.input.requestId,
      status: 'streaming',
      original: FIRST,
      draft: '',
      result: null,
      error: null,
      from: 1,
      to: FIRST_END
    })
    expect(rewriteTargetOf(editor.state)).toEqual({ from: 1, to: FIRST_END, text: FIRST })
    expect(useAiActivityStore.getState().inflight[request.input.requestId]?.feature).toBe('rewrite')
    deltaListener?.({ requestId: request.input.requestId, delta: 'The storm ' })
    deltaListener?.({ requestId: 'someone-else', delta: 'nope' })
    deltaListener?.({ requestId: request.input.requestId, delta: 'came down' })
    expect(session()?.draft).toBe('The storm came down')
    request.resolve(ok(request.input.requestId))
    await flush()
    expect(session()).toMatchObject({
      status: 'ready',
      draft: ANSWER,
      result: {
        text: ANSWER,
        flagged: false,
        violation: null,
        proposalId: 'p1',
        model: 'gpt-5.4-mini',
        costUsd: 0.0002,
        cached: false
      }
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
    // A late delta changes nothing once the answer is in.
    deltaListener?.({ requestId: request.input.requestId, delta: '!' })
    expect(session()?.draft).toBe(ANSWER)
  })

  it('refuses a selection outside the bounds and a second rewrite while one runs', async () => {
    editor.commands.setTextSelection({ from: 1, to: 10 })
    store().start('sc-1', editor)
    expect(session()).toBeNull()
    expect(requests).toHaveLength(0)
    await startFirst()
    editor.commands.setTextSelection({ from: 1, to: FIRST_END })
    store().start('sc-1', editor)
    expect(requests).toHaveLength(1)
  })

  it('accept replaces the passage through the editor, settles accepted, and ends the session', async () => {
    await ready()
    store().accept(editor)
    expect(paragraphs()).toEqual(['The storm came down at dusk. Rain came after.', SECOND])
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      ANSWER
    )
    expect(session()).toBeNull()
    expect(rewriteTargetOf(editor.state)).toBeNull()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('reject settles rejected and clears the highlight; Close on an error settles nothing', async () => {
    await ready()
    store().reject()
    expect(session()).toBeNull()
    expect(rewriteTargetOf(editor.state)).toBeNull()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])

    const request = await startFirst()
    request.resolve({
      ok: false,
      code: 'NO_KEY',
      message: 'No OpenAI key is saved.',
      nextStep: 'Add one in Settings.',
      requestId: request.input.requestId
    })
    await flush()
    expect(session()).toMatchObject({
      status: 'error',
      error: 'No OpenAI key is saved. Add one in Settings.'
    })
    expect(useDialogStore.getState().toasts).toEqual([])
    store().reject()
    expect(session()).toBeNull()
    await flush()
    expect(settles).toHaveLength(1)
  })

  it('a thrown request error shows in the panel state', async () => {
    const request = await startFirst()
    request.reject(new IpcRequestError({ code: 'VALIDATION', message: 'Select a document.' }))
    await flush()
    expect(session()).toMatchObject({ status: 'error', error: 'Select a document.' })
  })

  it('stop cancels and clears at once; the late answer rejects its proposal', async () => {
    const request = await startFirst()
    store().stop()
    expect(cancels).toEqual([request.input.requestId])
    expect(session()).toBeNull()
    expect(rewriteTargetOf(editor.state)).toBeNull()
    request.resolve(ok(request.input.requestId, { proposalId: 'p-late' }))
    await flush()
    expect(settles).toEqual([{ id: 'p-late', status: 'rejected', note: null }])
    // The passage is free for a new rewrite at once.
    await startFirst()
    expect(session()?.status).toBe('streaming')
  })

  it('a CANCELLED reply clears silently; stop does nothing once the answer is in', async () => {
    const request = await startFirst()
    request.resolve({
      ok: false,
      code: 'CANCELLED',
      message: 'Stopped.',
      nextStep: 'Send it again whenever you like.',
      requestId: request.input.requestId
    })
    await flush()
    expect(session()).toBeNull()
    expect(useDialogStore.getState().toasts).toEqual([])
    await ready()
    store().stop()
    expect(session()?.status).toBe('ready')
    expect(cancels).toEqual([])
  })

  it('an edit inside the passage invalidates a ready rewrite: accept is refused, reject still settles', async () => {
    await ready()
    editor.commands.insertContentAt(5, 'X')
    expect(session()?.status).toBe('invalid')
    expect(session()?.result?.text).toBe(ANSWER)
    store().accept(editor)
    expect(session()?.status).toBe('invalid')
    expect(paragraphs()[0]).toBe('The Xstorm broke at dusk. Rain followed.')
    store().reject()
    expect(session()).toBeNull()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])
  })

  it('an edit outside the passage keeps the rewrite valid; one inside during streaming lands it invalid', async () => {
    await ready()
    editor.commands.insertContentAt(FIRST_END, ' Then silence.')
    expect(session()?.status).toBe('ready')
    store().reject()
    await flush()
    const request = await startFirst()
    editor.commands.deleteRange({ from: 5, to: 10 })
    request.resolve(ok(request.input.requestId, { proposalId: 'p2' }))
    await flush()
    expect(session()?.status).toBe('invalid')
  })

  it('regenerate settles the shown proposal regenerated with the note and sends again with the predecessor', async () => {
    const first = await ready()
    store().regenerate('Keep the short sentences.')
    await flush()
    expect(settles).toEqual([
      { id: 'p1', status: 'regenerated', note: 'Keep the short sentences.' }
    ])
    expect(requests).toHaveLength(2)
    const second = requests[1]!
    expect(second.input).toEqual({
      nodeId: 'sc-1',
      from: 1,
      to: FIRST_END,
      text: FIRST,
      before: '',
      after: `\n\n${SECOND}`,
      requestId: expect.stringMatching(/^rw-/) as string,
      note: 'Keep the short sentences.',
      regeneratedFrom: 'p1'
    })
    expect(second.input.requestId).not.toBe(first.input.requestId)
    expect(session()).toMatchObject({ status: 'streaming', draft: '', result: null })
    second.resolve(
      ok(second.input.requestId, {
        proposalId: 'p2',
        flagged: true,
        violation: 'switches to present tense'
      })
    )
    await flush()
    expect(session()).toMatchObject({
      status: 'ready',
      result: { proposalId: 'p2', flagged: true, violation: 'switches to present tense' }
    })
  })

  it('dismissFor ends the rewrite for its document only, and copes with a destroyed editor', async () => {
    const request = await startFirst()
    store().dismissFor('sc-2')
    expect(session()?.status).toBe('streaming')
    editor.destroy()
    store().dismissFor('sc-1')
    expect(session()).toBeNull()
    expect(cancels).toEqual([request.input.requestId])
  })
})
