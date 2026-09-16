import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BetaReaderItem, BetaReaderScene } from '@shared/betaReader'
import type { AiBetaReaderResult, Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetBetaReaderStore, useBetaReaderStore } from './betaReaderStore'
import { resetDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'

interface PendingRead {
  input: Input<'ai:betaReader'>
  resolve: (result: AiBetaReaderResult) => void
  reject: (err: Error) => void
}

const FIRST = 'The storm broke at dusk. Rain followed.'
const SECOND = 'Nobody answered him, and the quiet held on after.'

let editor: Editor
let requests: PendingRead[]
let settles: Input<'proposal:settle'>[]
let cancels: string[]

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'ai:betaReader') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:betaReader'>,
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
    on: () => () => {}
  }
}

/** Two scenes read: the opening through its summary, this one in full. */
const SCENES: BetaReaderScene[] = [
  { nodeId: 'sc-0', title: 'Chapter 1 › Opening', current: false },
  { nodeId: 'sc-1', title: 'Chapter 1 › The Ferry', current: true }
]

const item = (over: Partial<BetaReaderItem> = {}): BetaReaderItem => ({
  category: 'expects',
  scene: 2,
  quote: 'Rain followed.',
  note: 'The reader expects the weather to matter.',
  ...over
})

/** An item citing the earlier scene: its quote is in that summary, not in this document. */
const EARLIER = item({
  category: 'knows',
  scene: 1,
  quote: 'He missed the last ferry',
  note: 'The reader knows he is stranded.'
})

const ok = (requestId: string, over: Partial<Extract<AiBetaReaderResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    items: [item(), EARLIER],
    scenes: SCENES,
    truncated: false,
    skipped: 0,
    missing: 1,
    dropped: 1,
    usage: { inputTokens: 1_400, outputTokens: 180 },
    costUsd: 0.03,
    cached: false,
    model: 'gpt-5.4',
    proposalId: 'p1',
    requestId,
    ...over
  }) satisfies AiBetaReaderResult

const session = () => useBetaReaderStore.getState().session
const store = () => useBetaReaderStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Starts a read for the open document and hands back the request. */
async function start(): Promise<PendingRead> {
  store().start('sc-1')
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

/** Starts and answers a read so the panel has a report. */
async function ready(
  over: Partial<Extract<AiBetaReaderResult, { ok: true }>> = {}
): Promise<PendingRead> {
  const request = await start()
  request.resolve(ok(request.input.requestId, over))
  await flush()
  expect(session()?.status).toBe('ready')
  return request
}

beforeEach(() => {
  resetTagStore()
  resetBetaReaderStore()
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
  resetBetaReaderStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('betaReaderStore (F-14.11)', () => {
  it('start sends the node, tracks the request, and fills the panel with the report', async () => {
    const request = await start()
    expect(request.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.stringMatching(/^br-/) as string
    })
    expect(session()).toMatchObject({ nodeId: 'sc-1', status: 'pending', items: [], scenes: [] })
    expect(useAiActivityStore.getState().inflight[request.input.requestId]?.feature).toBe(
      'betaReader'
    )
    request.resolve(ok(request.input.requestId))
    await flush()
    expect(session()).toMatchObject({
      status: 'ready',
      items: [item(), EARLIER],
      scenes: SCENES,
      stale: [false, false],
      result: {
        proposalId: 'p1',
        model: 'gpt-5.4',
        costUsd: 0.03,
        cached: false,
        truncated: false,
        skipped: 0,
        missing: 1,
        dropped: 1
      }
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('refuses a second read while one runs', async () => {
    await start()
    store().start('sc-1')
    expect(requests).toHaveLength(1)
  })

  it('show selects the passage an item cites in this scene', async () => {
    await ready()
    store().show(0, editor)
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Rain followed.')
    expect(session()?.stale).toEqual([false, false])
  })

  it('leaves an item citing an earlier scene alone: its words are not in this document', async () => {
    await ready()
    const before = editor.state.selection
    store().show(1, editor)
    expect(editor.state.selection.from).toBe(before.from)
    expect(session()?.stale).toEqual([false, false])
  })

  it('marks an item stale when its quote is gone from the scene', async () => {
    await ready({ items: [item({ quote: 'The lighthouse blinked twice.' })] })
    store().show(0, editor)
    expect(session()?.stale).toEqual([true])
    // A second click changes nothing: the panel greys the quote.
    store().show(0, editor)
    expect(session()?.stale).toEqual([true])
  })

  it('regenerate settles the shown proposal regenerated and asks again with the note', async () => {
    const first = await ready()
    store().regenerate('Read it as someone who skipped the prologue.')
    await flush()
    expect(settles).toEqual([
      { id: 'p1', status: 'regenerated', note: 'Read it as someone who skipped the prologue.' }
    ])
    expect(requests).toHaveLength(2)
    const second = requests[1]!
    expect(second.input).toEqual({
      nodeId: 'sc-1',
      requestId: expect.stringMatching(/^br-/) as string,
      note: 'Read it as someone who skipped the prologue.',
      regeneratedFrom: 'p1'
    })
    expect(second.input.requestId).not.toBe(first.input.requestId)
    expect(session()).toMatchObject({ status: 'pending', items: [], result: null })
    second.resolve(ok(second.input.requestId, { proposalId: 'p2' }))
    await flush()
    expect(session()).toMatchObject({ status: 'ready', result: { proposalId: 'p2' } })
  })

  it('close settles the proposal rejected: a report is never applied', async () => {
    await ready()
    store().close()
    expect(session()).toBeNull()
    await flush()
    expect(settles).toEqual([{ id: 'p1', status: 'rejected', note: null }])
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

  it('dismissFor ends the read for its document only', async () => {
    const request = await start()
    store().dismissFor('sc-2')
    expect(session()?.status).toBe('pending')
    store().dismissFor('sc-1')
    expect(session()).toBeNull()
    expect(cancels).toEqual([request.input.requestId])
  })
})
