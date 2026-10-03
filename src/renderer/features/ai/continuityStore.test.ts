import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContinuityFinding } from '@shared/continuity'
import type {
  AiContinuityResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetRewriteStore, useRewriteStore } from '@renderer/features/editor/rewriteStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetAiActivityStore, useAiActivityStore } from './aiActivityStore'
import {
  CONTINUITY_FIRST,
  CONTINUITY_FIX,
  CONTINUITY_SECOND,
  continuityOk,
  finding,
  hairFinding
} from './continuityFixture'
import { resetContinuityStore, useContinuityStore } from './continuityStore'
import { resetProposalStore } from './proposalStore'

interface PendingCheck {
  input: Input<'ai:continuity'>
  resolve: (result: AiContinuityResult) => void
  reject: (err: Error) => void
}

let editor: Editor
let listed: ContinuityFinding[]
let lists: number
let requests: PendingCheck[]
let settles: Input<'continuity:settle'>[]
let proposals: Input<'proposal:settle'>[]
let cancels: string[]
let settleFails: boolean
let changed: ((payload: EventPayload<'continuity:changed'>) => void) | null

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'continuity:list') {
        lists++
        return listed as Output<C>
      }
      if (channel === 'ai:continuity') {
        return new Promise<Output<C>>((resolve, reject) => {
          requests.push({
            input: input as Input<'ai:continuity'>,
            resolve: (result) => resolve(result as Output<C>),
            reject
          })
        })
      }
      if (channel === 'continuity:settle') {
        if (settleFails)
          throw new IpcRequestError({ code: 'NOT_FOUND', message: 'No such finding' })
        const asked = input as Input<'continuity:settle'>
        settles.push(asked)
        return finding({ id: asked.id, status: asked.status }) as Output<C>
      }
      if (channel === 'proposal:settle') {
        proposals.push(input as Input<'proposal:settle'>)
        return null as Output<C>
      }
      if (channel === 'ai:cancel') {
        cancels.push((input as Input<'ai:cancel'>).requestId)
        return { cancelled: true } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
      if (event === 'continuity:changed') {
        changed = listener as (payload: EventPayload<'continuity:changed'>) => void
      }
      return () => {
        if (event === 'continuity:changed') changed = null
      }
    }
  }
}

const store = () => useContinuityStore.getState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}

async function start(nodeId = 'sc-1'): Promise<PendingCheck> {
  store().check(nodeId)
  await flush()
  const request = requests.at(-1)
  if (!request) throw new Error('no request left')
  return request
}

beforeEach(() => {
  resetTagStore()
  resetContinuityStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  listed = []
  lists = 0
  requests = []
  settles = []
  proposals = []
  cancels = []
  settleFails = false
  changed = null
  setIpcClient(fakeClient())
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: CONTINUITY_FIRST }] },
        { type: 'paragraph', content: [{ type: 'text', text: CONTINUITY_SECOND }] }
      ]
    }
  })
})
afterEach(() => {
  resetContinuityStore()
  resetRewriteStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetProposalStore()
  if (!editor.isDestroyed) editor.destroy()
  setIpcClient(null)
})

describe('continuityStore (F-13.4)', () => {
  it('loads the open findings normalized by id, in the order received', async () => {
    listed = [hairFinding(), finding(), finding({ id: 'f-3', status: 'dismissed' })]
    await store().load()
    expect(store().ids).toEqual(['f-2', 'f-1'])
    expect(store().byId['f-1']?.quote).toBe('Mara was twenty-nine that spring.')
    expect(store().loaded).toBe(true)
  })

  it('re-reads the list on continuity:changed, through one subscription', async () => {
    await store().load()
    await store().load()
    expect(store().ids).toEqual([])
    listed = [finding()]
    changed?.({ nodeIds: ['sc-1'] })
    await flush()
    expect(store().ids).toEqual(['f-1'])
    expect(lists).toBe(3)
  })

  it('clear forgets the findings and drops an answer still on the way', async () => {
    listed = [finding()]
    const loading = store().load()
    store().clear()
    await loading
    expect(store().ids).toEqual([])
    expect(store().loaded).toBe(false)
  })

  it('check sends the node with a request id, tracks it, and replaces the scene’s findings', async () => {
    listed = [finding({ id: 'old', nodeId: 'sc-1' }), finding({ id: 'other', nodeId: 'sc-2' })]
    await store().load()
    const request = await start()
    expect(request.input.nodeId).toBe('sc-1')
    expect(store().running).toEqual({ nodeId: 'sc-1', requestId: request.input.requestId })
    expect(useAiActivityStore.getState().inflight[request.input.requestId]?.feature).toBe(
      'continuity'
    )
    // A second click while one runs sends nothing.
    store().check('sc-1')
    await flush()
    expect(requests).toHaveLength(1)
    request.resolve(continuityOk(request.input.requestId, { dropped: 1, cached: true }))
    await flush()
    expect(store().running).toBeNull()
    expect(store().ids).toEqual(['f-1', 'f-2', 'other'])
    expect(store().outcome).toMatchObject({
      nodeId: 'sc-1',
      found: 2,
      references: 4,
      dropped: 1,
      cached: true,
      model: 'gpt-5.4'
    })
    expect(useAiActivityStore.getState().inflight).toEqual({})
  })

  it('keeps a check with no references as an outcome with nothing found', async () => {
    const request = await start()
    request.resolve(
      continuityOk(request.input.requestId, { findings: [], references: 0, proposalId: null })
    )
    await flush()
    expect(store().outcome).toMatchObject({ found: 0, references: 0 })
    expect(store().ids).toEqual([])
  })

  it('shows an AI failure with its next step, and a thrown one with its message', async () => {
    const request = await start()
    request.resolve({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is set.',
      nextStep: 'Add one in Settings.',
      requestId: request.input.requestId
    })
    await flush()
    expect(store().error).toBe('No API key is set. Add one in Settings.')
    expect(store().running).toBeNull()
    const second = await start()
    expect(store().error).toBeNull()
    second.reject(new IpcRequestError({ code: 'VALIDATION', message: 'The scene is too short' }))
    await flush()
    expect(store().error).toBe('The scene is too short')
  })

  it('stop cancels the request, and its late answers are ignored', async () => {
    const request = await start()
    store().stop()
    expect(store().running).toBeNull()
    expect(cancels).toEqual([request.input.requestId])
    request.resolve({
      ok: false,
      code: 'CANCELLED',
      message: 'Stopped.',
      nextStep: '',
      requestId: request.input.requestId
    })
    await flush()
    expect(store().error).toBeNull()
    expect(store().outcome).toBeNull()
  })

  it('a CANCELLED reply to a running check is silent', async () => {
    const request = await start()
    request.resolve({
      ok: false,
      code: 'CANCELLED',
      message: 'Stopped.',
      nextStep: '',
      requestId: request.input.requestId
    })
    await flush()
    expect(store().running).toBeNull()
    expect(store().error).toBeNull()
  })

  it('dismisses a finding, and leaves the proposal to main', async () => {
    listed = [finding(), hairFinding()]
    await store().load()
    await store().settle('f-1', 'dismissed')
    expect(settles).toEqual([{ id: 'f-1', status: 'dismissed' }])
    expect(store().ids).toEqual(['f-2'])
    expect(proposals).toEqual([])
    await store().settle('f-2', 'dismissed')
    await flush()
    expect(store().ids).toEqual([])
    expect(proposals).toEqual([])
  })

  it('keeps the finding and toasts when the settle fails', async () => {
    listed = [finding()]
    await store().load()
    settleFails = true
    await store().settle('f-1', 'dismissed')
    expect(store().ids).toEqual(['f-1'])
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['No such finding'])
  })

  it('apply replaces the passage as AI-origin text and records applied', async () => {
    listed = [finding(), hairFinding()]
    await store().load()
    await store().apply('f-1', editor)
    expect(paragraphs()).toEqual([`${CONTINUITY_FIX} The rain held off.`, CONTINUITY_SECOND])
    expect(editor.view.dom.querySelector('.ai-origin[data-proposal-id="p1"]')?.textContent).toBe(
      CONTINUITY_FIX
    )
    expect(settles).toEqual([{ id: 'f-1', status: 'applied' }])
    expect(store().ids).toEqual(['f-2'])
    // Another fix of the same run is still open: part of the proposal is in the text.
    expect(proposals).toEqual([])
    expect(editor.view.dom.querySelectorAll('.rewrite-target')).toHaveLength(0)
  })

  it('apply leaves the proposal to main when it was the run’s only fix', async () => {
    listed = [finding()]
    await store().load()
    await store().apply('f-1', editor)
    expect(proposals).toEqual([])
  })

  it('marks a finding gone when its quote left the scene, and changes nothing', async () => {
    listed = [finding({ quote: 'Mara was forty that spring.' })]
    await store().load()
    await store().apply('f-1', editor)
    expect(store().gone).toEqual({ 'f-1': true })
    expect(paragraphs()).toEqual([CONTINUITY_FIRST, CONTINUITY_SECOND])
    expect(settles).toEqual([])
    expect(proposals).toEqual([])
  })

  it('does not apply without a fix, without a proposal, or while a rewrite holds the editor', async () => {
    listed = [finding({ fix: null }), hairFinding({ proposalId: null })]
    await store().load()
    await store().apply('f-1', editor)
    await store().apply('f-2', editor)
    listed = [finding()]
    changed?.({ nodeIds: ['sc-1'] })
    await flush()
    useRewriteStore.setState({
      session: {
        nodeId: 'sc-1',
        requestId: 'rw-1',
        status: 'streaming',
        original: 'Mara',
        draft: '',
        result: null,
        error: null,
        from: 1,
        to: 5
      }
    })
    await store().apply('f-1', editor)
    expect(paragraphs()).toEqual([CONTINUITY_FIRST, CONTINUITY_SECOND])
    expect(settles).toEqual([])
    expect(store().gone).toEqual({})
  })
})
