import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CritiqueNote } from '@shared/critique'
import type { AiCritiqueResult, Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetCritiqueStore, useCritiqueStore } from './critiqueStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { resetRewriteStore, useRewriteStore } from './rewriteStore'

interface PendingCritique {
  input: Input<'ai:critique'>
  resolve: (result: AiCritiqueResult) => void
  reject: (err: Error) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const SECOND = 'Nobody answered him, and the quiet held on after.'
const FIX = 'Rain came down after it.'

let editor: Editor
let requests: PendingCritique[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:critique') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:critique'>,
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

const note = (over: Partial<CritiqueNote> = {}): CritiqueNote => ({
  kind: 'issue',
  category: 'pacing',
  quote: 'Rain followed.',
  why: 'The beat lands flat.',
  fix: FIX,
  flagged: false,
  violation: null,
  ...over
})

const PRAISE = note({
  kind: 'praise',
  category: 'clarity',
  quote: 'Nobody answered him',
  why: 'The silence does the work.',
  fix: null
})

const ok = (requestId: string, over: Partial<Extract<AiCritiqueResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    notes: [note(), PRAISE],
    truncated: false,
    dropped: 1,
    usage: { inputTokens: 900, outputTokens: 120 },
    costUsd: 0.02,
    cached: false,
    model: 'gpt-5.4',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiCritiqueResult

const session = () => useCritiqueStore.getState().session
const store = () => useCritiqueStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** Each paragraph's text; a tag token or a hard break reads as nothing. */
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}

/** Starts a critique for the open document and hands back the request. */
async function start(): Promise<PendingCritique> {
  store().start('sc-1')
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

/** Starts and answers a critique so the panel has notes. */
async function ready(
  over: Partial<Extract<AiCritiqueResult, { ok: true }>> = {}
): Promise<PendingCritique> {
  const request = await start()
  request.resolve(ok(request.input.requestId, over))
  await flush()
  expect(session()?.status).toBe('ready')
  return request
}

beforeEach(() => {
  resetTagStore()
  resetCritiqueStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  requests = []
  settles = []
  cancels = []
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
  resetCritiqueStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('critiqueStore (F-14.8)', () => {
  it('start sends the node, tracks the request, and fills the panel with the notes', async () => {
    const request = await start()
    expect(request.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.stringMatching(/^cr-/) as string
    })
    expect(session()).toMatchObject({ nodeId: 'sc-1', status: 'pending', notes: [] })
    expect(useAiActivityStore.getState().inflight[request.input.requestId]?.feature).toBe(
      'critique'
    )
    request.resolve(ok(request.input.requestId))
    await flush()
    expect(session()).toMatchObject({
      status: 'ready',
      notes: [note(), PRAISE],
      applied: [false, false],
      stale: [false, false],
      result: {
        proposalId: 'p1',
        model: 'gpt-5.4',
        costUsd: 0.02,
        cached: false,
        truncated: false,
        dropped: 1
      }
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('refuses a second critique while one runs', async () => {
    await start()
    store().start('sc-1')
    expect(requests).toHaveLength(1)
  })

  it('applyFix replaces the cited passage as AI-origin text and marks the note applied', async () => {
    await ready()
    store().applyFix(0, editor)
    expect(paragraphs()).toEqual([`The storm broke at dusk. ${FIX}`, SECOND])
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      FIX
    )
    expect(session()?.applied).toEqual([true, false])
    // A second click changes nothing, and a praise note has no fix to apply.
    store().applyFix(0, editor)
    store().applyFix(1, editor)
    expect(paragraphs()[0]).toBe(`The storm broke at dusk. ${FIX}`)
    expect(session()?.applied).toEqual([true, false])
    expect(editor.view.dom.querySelectorAll('.rewrite-target')).toHaveLength(0)
  })

  it('marks a note stale when its quote is gone, and leaves the document alone', async () => {
    await ready({ notes: [note({ quote: 'The lighthouse blinked twice.' })] })
    store().applyFix(0, editor)
    expect(session()?.stale).toEqual([true])
    expect(session()?.applied).toEqual([false])
    expect(paragraphs()).toEqual([FIRST, SECOND])
    store().show(0, editor)
    expect(session()?.stale).toEqual([true])
  })

  it('show selects the cited passage', async () => {
    await ready()
    store().show(1, editor)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Nobody answered him')
    expect(session()?.stale).toEqual([false, false])
  })

  it('refuses to apply a fix while a rewrite holds the editor', async () => {
    await ready()
    editor.commands.setTextSelection({ from: 1, to: FIRST.length + 1 })
    useRewriteStore.getState().start('sc-1', editor)
    await flush()
    expect(useRewriteStore.getState().session).not.toBeNull()
    store().applyFix(0, editor)
    expect(paragraphs()).toEqual([FIRST, SECOND])
    expect(session()?.applied).toEqual([false, false])
  })

  it('close settles the proposal by the fixes applied: none, some, or all', async () => {
    await ready()
    store().close()
    expect(session()).toBeNull()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])

    settles = []
    resetProposalStore()
    await ready({ notes: [note(), note({ quote: 'Nobody answered him', fix: 'Nobody spoke.' })] })
    store().applyFix(0, editor)
    store().close()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'acceptedPart', note: null }])

    settles = []
    resetProposalStore()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: FIRST }] }]
    })
    await ready({ notes: [note(), PRAISE] })
    store().applyFix(0, editor)
    store().close()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'accepted', note: null }])
  })

  it('regenerate settles the shown proposal regenerated and asks again with the note', async () => {
    const first = await ready()
    store().regenerate('Too gentle; say what is wrong.')
    await flush()
    expect(settles).toEqual([
      { id: 'p1', status: 'regenerated', note: 'Too gentle; say what is wrong.' }
    ])
    expect(requests).toHaveLength(2)
    const second = requests[1]!
    expect(second.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.stringMatching(/^cr-/) as string,
      note: 'Too gentle; say what is wrong.',
      regeneratedFrom: 'p1'
    })
    expect(second.input.requestId).not.toBe(first.input.requestId)
    expect(session()).toMatchObject({ status: 'pending', notes: [], result: null })
    second.resolve(ok(second.input.requestId, { proposalId: 'p2' }))
    await flush()
    expect(session()).toMatchObject({ status: 'ready', result: { proposalId: 'p2' } })
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
    expect(useDialogStore.getState().toasts).toEqual([])

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
    expect(useDialogStore.getState().toasts).toEqual([])
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

  it('dismissFor ends the critique for its document only', async () => {
    const request = await start()
    store().dismissFor('sc-2')
    expect(session()?.status).toBe('pending')
    store().dismissFor('sc-1')
    expect(session()).toBeNull()
    expect(cancels).toEqual([request.input.requestId])
  })
})
