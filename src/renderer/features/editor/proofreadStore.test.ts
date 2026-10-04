import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiProofreadResult, Channel, Input, Output } from '@shared/ipc/contract'
import { PROOFREAD_CHAR_BUDGET, type ProofreadFix } from '@shared/proofread'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { REWRITE_BUSY_MESSAGE } from './applyFix'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { resetProofreadStore, useProofreadStore } from './proofreadStore'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingProofread {
  input: Input<'ai:proofread'>
  resolve: (result: AiProofreadResult) => void
  reject: (err: Error) => void
}

const FIRST = 'The strom broke at dusk. Rain folowed.'
const SECOND = 'Nobody answered him, and the the quiet held.'

let editor: Editor
let requests: PendingProofread[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:proofread') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:proofread'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'ai:rewrite') return new Promise<Output<C>>(() => {})
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
    on: () => () => {}
  }
}

const fix = (over: Partial<ProofreadFix> = {}): ProofreadFix => ({
  kind: 'spelling',
  quote: 'The strom broke',
  fix: 'The storm broke',
  flagged: false,
  violation: null,
  ...over
})

const STORM = fix()
const FOLLOWED = fix({ quote: 'Rain folowed.', fix: 'Rain followed.' })
const DOUBLED = fix({ kind: 'doubledWord', quote: 'and the the quiet', fix: 'and the quiet' })

const ok = (requestId: string, over: Partial<Extract<AiProofreadResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    fixes: [STORM, FOLLOWED, DOUBLED],
    scope: 'scene',
    truncated: false,
    dropped: 1,
    usage: { inputTokens: 700, outputTokens: 90 },
    costUsd: 0.001,
    cached: false,
    model: 'gpt-5.4-mini',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiProofreadResult

const session = () => useProofreadStore.getState().session
const store = () => useProofreadStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

/** Starts a pass for the open document and hands back the request. */
async function start(): Promise<PendingProofread> {
  store().start('sc-1', editor)
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

/** Starts and answers a pass so the panel has fixes. */
async function ready(
  over: Partial<Extract<AiProofreadResult, { ok: true }>> = {}
): Promise<PendingProofread> {
  const request = await start()
  request.resolve(ok(request.input.requestId, over))
  await flush()
  expect(session()?.status).toBe('ready')
  return request
}

function mount(texts: string[]): void {
  if (editor !== undefined && !editor.isDestroyed) editor.destroy()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
    }
  })
}

beforeEach(() => {
  resetTagStore()
  resetProofreadStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
  setIpcClient(fakeClient())
  mount([FIRST, SECOND])
})
afterEach(() => {
  resetProofreadStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('proofreadStore (F-14.12)', () => {
  it('start sends the scene, tracks the request, and fills the panel with open fixes', async () => {
    const request = await start()
    expect(request.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.stringMatching(/^pr-/) as string,
      selection: null
    })
    expect(session()).toMatchObject({ nodeId: 'sc-1', status: 'pending', scope: 'scene' })
    expect(useAiActivityStore.getState().inflight[request.input.requestId]?.feature).toBe(
      'proofread'
    )
    request.resolve(ok(request.input.requestId))
    await flush()
    expect(session()).toMatchObject({
      status: 'ready',
      scope: 'scene',
      fixes: [STORM, FOLLOWED, DOUBLED],
      states: ['open', 'open', 'open'],
      settled: false,
      result: {
        proposalId: 'p1',
        model: 'gpt-5.4-mini',
        costUsd: 0.001,
        cached: false,
        truncated: false,
        dropped: 1
      }
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('sends a selection of 20 characters or more, and the scene for a shorter one', async () => {
    editor.commands.setTextSelection({ from: 1, to: 10 })
    const short = await start()
    expect(short.input.selection).toBeNull()
    store().stop()

    editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
    const long = await start()
    expect(long.input.selection).toBe(FIRST)
    expect(session()?.scope).toBe('selection')
    long.resolve(ok(long.input.requestId, { scope: 'selection' }))
    await flush()
    expect(session()?.scope).toBe('selection')
  })

  it('head-truncates a selection over the budget and says the text was truncated', async () => {
    const long = 'Rain fell on the hill. '.repeat(Math.ceil(PROOFREAD_CHAR_BUDGET / 23) + 2)
    mount([long])
    editor.commands.selectAll()
    const request = await start()
    expect(request.input.selection).toHaveLength(PROOFREAD_CHAR_BUDGET)
    request.resolve(ok(request.input.requestId, { fixes: [], scope: 'selection' }))
    await flush()
    expect(session()?.result?.truncated).toBe(true)
  })

  it('refuses a second pass while one runs', async () => {
    await start()
    store().start('sc-1', editor)
    expect(requests).toHaveLength(1)
  })

  it('accept replaces the quoted passage as AI-origin text and marks the fix applied', async () => {
    await ready()
    store().accept(0, editor)
    expect(paragraphs()).toEqual(['The storm broke at dusk. Rain folowed.', SECOND])
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      'The storm broke'
    )
    expect(session()?.states).toEqual(['applied', 'open', 'open'])
    store().accept(0, editor)
    expect(paragraphs()[0]).toBe('The storm broke at dusk. Rain folowed.')
    expect(editor.view.dom.querySelectorAll('.rewrite-target')).toHaveLength(0)
    await flush()
    expect(settles).toEqual([])
  })

  it('settles once when the last open fix resolves; the panel stays until closed', async () => {
    await ready()
    store().accept(0, editor)
    store().reject(1)
    store().reject(1)
    expect(session()?.states).toEqual(['applied', 'rejected', 'open'])
    store().reject(2)
    expect(session()?.states).toEqual(['applied', 'rejected', 'rejected'])
    expect(session()?.settled).toBe(true)
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'acceptedPart', note: null }])
    store().close()
    await flush()
    expect(session()).toBeNull()
    expect(settles).toHaveLength(1)
  })

  it('accept all applies every open fix in order and settles accepted', async () => {
    await ready()
    store().reject(1)
    store().acceptAll(editor)
    expect(paragraphs()).toEqual([
      'The storm broke at dusk. Rain folowed.',
      'Nobody answered him, and the quiet held.'
    ])
    expect(session()?.states).toEqual(['applied', 'rejected', 'applied'])
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'acceptedPart', note: null }])

    settles = []
    store().close()
    resetProposalStore()
    mount([FIRST, SECOND])
    await ready()
    store().acceptAll(editor)
    expect(paragraphs()).toEqual([
      'The storm broke at dusk. Rain followed.',
      'Nobody answered him, and the quiet held.'
    ])
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('every fix rejected settles rejected', async () => {
    await ready()
    store().reject(0)
    store().reject(1)
    store().reject(2)
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])
    expect(paragraphs()).toEqual([FIRST, SECOND])
  })

  it('close settles by the fixes applied so far, and an empty result settles rejected', async () => {
    await ready()
    store().accept(1, editor)
    store().close()
    await flush()
    expect(session()).toBeNull()
    expect(settles).toEqual([{ id: 'p1', status: 'acceptedPart', note: null }])

    settles = []
    resetProposalStore()
    await ready({ fixes: [], proposalId: 'p2' })
    expect(session()?.settled).toBe(false)
    store().close()
    await flush()
    expect(settles).toEqual([{ id: 'p2', status: 'rejected', note: null }])
  })

  it('marks a fix stale when its quote is gone, and leaves the document alone', async () => {
    await ready({ fixes: [fix({ quote: 'The lighthouse blinked twice.' }), FOLLOWED] })
    store().accept(0, editor)
    expect(session()?.states).toEqual(['stale', 'open'])
    expect(paragraphs()).toEqual([FIRST, SECOND])
    store().close()

    await ready({ fixes: [fix({ quote: 'The lighthouse blinked twice.' })], proposalId: 'p3' })
    store().show(0, editor)
    expect(session()?.states).toEqual(['stale'])
    // Stale was the last open fix: the proposal settles with nothing applied.
    await flush()
    expect(settles.at(-1)).toEqual({ id: 'p3', status: 'rejected', note: null })
  })

  it('show selects the quoted passage', async () => {
    await ready()
    store().show(2, editor)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('and the the quiet')
    expect(session()?.states).toEqual(['open', 'open', 'open'])
  })

  it('refuses to accept while a rewrite holds the editor, with a toast', async () => {
    await ready()
    editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
    useRewriteStore.getState().start('sc-1', editor)
    await flush()
    expect(useRewriteStore.getState().session).not.toBeNull()
    store().accept(0, editor)
    expect(toasts()).toEqual([REWRITE_BUSY_MESSAGE])
    store().acceptAll(editor)
    expect(toasts()).toEqual([REWRITE_BUSY_MESSAGE, REWRITE_BUSY_MESSAGE])
    expect(paragraphs()).toEqual([FIRST, SECOND])
    expect(session()?.states).toEqual(['open', 'open', 'open'])
  })

  it('stop cancels and clears at once; the late answer rejects its proposal', async () => {
    const request = await start()
    store().stop()
    expect(cancels).toEqual([request.input.requestId])
    expect(session()).toBeNull()
    request.resolve(ok(request.input.requestId, { proposalId: 'p-late' }))
    await flush()
    expect(settles).toEqual([{ id: 'p-late', status: 'rejected', note: null }])
    await start()
    expect(session()?.status).toBe('pending')
  })

  it('a CANCELLED reply clears silently; every other failure shows in the panel', async () => {
    const first = await start()
    first.resolve({
      ok: false,
      code: 'CANCELLED',
      message: 'Stopped.',
      nextStep: 'Send it again whenever you like.',
      requestId: first.input.requestId
    })
    await flush()
    expect(session()).toBeNull()
    expect(toasts()).toEqual([])

    const second = await start()
    second.resolve({
      ok: false,
      code: 'NO_KEY',
      message: 'No OpenAI key is saved.',
      nextStep: 'Add one in Settings.',
      requestId: second.input.requestId
    })
    await flush()
    expect(session()).toMatchObject({
      status: 'error',
      error: 'No OpenAI key is saved. Add one in Settings.'
    })
    store().close()
    expect(session()).toBeNull()
    await flush()
    expect(settles).toEqual([])
  })

  it('a thrown request error shows in the panel state', async () => {
    const request = await start()
    request.reject(
      new IpcRequestError({ code: 'VALIDATION', message: 'Write a little more first.' })
    )
    await flush()
    expect(session()).toMatchObject({ status: 'error', error: 'Write a little more first.' })
  })

  it('dismissFor ends the pass for its document only', async () => {
    const request = await start()
    store().dismissFor('sc-2')
    expect(session()?.status).toBe('pending')
    store().dismissFor('sc-1')
    expect(session()).toBeNull()
    expect(cancels).toEqual([request.input.requestId])
  })
})
