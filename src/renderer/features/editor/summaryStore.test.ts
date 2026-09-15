import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AiSummarizeResult,
  Channel,
  EventName,
  EventPayload,
  Input,
  Output
} from '@shared/ipc/contract'
import type { SceneSummaryState, StoredSceneSummary } from '@shared/summary'
import { resetAiActivityStore, useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { resetSummaryStore, useSummaryStore } from './summaryStore'

const ROW: StoredSceneSummary = {
  nodeId: 'sc-1',
  summary: 'Mara crosses the river alone and reaches the far bank before dawn.',
  keyPoints: ['The ferryman is gone.', 'She swims.'],
  characters: ['Mara', 'Tomas'],
  contentHash: 'h1',
  promptVersion: 'summary.v1',
  model: 'gpt-5.4-mini',
  truncated: false,
  createdAt: '2026-09-15T10:00:00.000Z'
}

const state = (over: Partial<SceneSummaryState> = {}): SceneSummaryState => ({
  available: true,
  summary: ROW,
  stale: false,
  status: 'idle',
  error: null,
  ...over
})

const ok = (over: Partial<Extract<AiSummarizeResult, { ok: true }>> = {}): AiSummarizeResult => ({
  ok: true,
  state: state(),
  usage: { inputTokens: 900, outputTokens: 80 },
  costUsd: 0.0003,
  cached: false,
  model: 'gpt-5.4-mini',
  requestId: 'req-1',
  ...over
})

type Handler = (input: unknown) => unknown

let calls: [Channel, unknown][]
let listener: ((payload: EventPayload<'ai:summaryChanged'>) => void) | null
let subscriptions: number
let unsubscribes: number

/** A fake main: `summary:get` answers `gets.shift()`, `ai:summarize` `results.shift()`. */
let gets: SceneSummaryState[]
let results: AiSummarizeResult[]

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      if (channel === 'summary:get') return (gets.shift() ?? state()) as Output<C>
      if (channel === 'ai:summarize') return (results.shift() ?? ok()) as Output<C>
      if (channel === 'document:save') return { modified: 'm', wordCount: 3 } as Output<C>
      if (channel === 'ai:cancel') return { cancelled: true } as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void) {
      if (event === 'ai:summaryChanged') {
        subscriptions += 1
        listener = fn as (payload: EventPayload<'ai:summaryChanged'>) => void
      }
      return () => {
        unsubscribes += 1
        listener = null
      }
    }
  }
  setIpcClient(client)
}

const store = () => useSummaryStore.getState()
const held = (id = 'sc-1'): SceneSummaryState | undefined => store().byNode[id]
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const channels = (): Channel[] => calls.map(([channel]) => channel)

beforeEach(() => {
  calls = []
  gets = []
  results = []
  listener = null
  subscriptions = 0
  unsubscribes = 0
  resetSummaryStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})

afterEach(() => {
  resetSummaryStore()
  resetDocumentStore()
  resetAiActivityStore()
  resetPendingSaves()
  setIpcClient(null)
})

describe('summaryStore (F-5.6)', () => {
  it('loads a node and opens the change subscription once', async () => {
    await store().load('sc-1')
    await store().load('sc-2')
    expect(held('sc-1')?.summary?.summary).toBe(ROW.summary)
    expect(held('sc-2')).toBeDefined()
    expect(subscriptions).toBe(1)
    expect(calls).toEqual([
      ['summary:get', { id: 'sc-1' }],
      ['summary:get', { id: 'sc-2' }]
    ])
  })

  it('toasts a failed load and holds nothing for the node', async () => {
    install({
      'summary:get': () => {
        throw new IpcRequestError({ code: 'NOT_FOUND', message: 'No such node.' })
      }
    })
    await store().load('sc-1')
    expect(held()).toBeUndefined()
    expect(toasts()).toEqual(['No such node.'])
  })

  it('flushes the document before it summarises and stores the answer', async () => {
    useDocumentStore.setState({
      docs: { 'sc-1': { content: { type: 'doc', content: [] }, dirty: false } }
    })
    useDocumentStore.getState().edit('sc-1', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The river ran high.' }] }]
    })
    await store().load('sc-1')
    calls = []
    await store().summarize('sc-1')
    expect(channels()).toEqual(['document:save', 'ai:summarize'])
    const request = calls[1]?.[1] as Input<'ai:summarize'> | undefined
    expect(request?.nodeId).toBe('sc-1')
    expect(request?.requestId).toEqual(expect.any(String))
    expect(held()).toEqual(state())
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false)
    expect(toasts()).toEqual([])
  })

  it('tracks the request so Cancel and the header indicator find it', async () => {
    let release: (result: AiSummarizeResult) => void = () => {}
    const pending = new Promise<AiSummarizeResult>((resolve) => {
      release = resolve
    })
    install({ 'ai:summarize': () => pending })
    await store().load('sc-1')
    const run = store().summarize('sc-1')
    await Promise.resolve()
    await Promise.resolve()
    const inflight = Object.entries(useAiActivityStore.getState().inflight)
    expect(inflight).toHaveLength(1)
    expect(inflight[0]?.[1].feature).toBe('summary')
    // The pane shows the old row while the new one is written.
    expect(held()?.status).toBe('pending')
    expect(held()?.summary?.summary).toBe(ROW.summary)
    release(ok({ state: state({ stale: false }) }))
    await run
    expect(useAiActivityStore.getState().inflight).toEqual({})
    expect(held()?.status).toBe('idle')
  })

  it('lands an expected failure in the node with its next step', async () => {
    results = [
      {
        ok: false,
        code: 'RATE_LIMIT',
        message: 'OpenAI is rate limiting this key.',
        nextStep: 'Wait a minute and try again.',
        requestId: 'req-1'
      }
    ]
    await store().load('sc-1')
    await store().summarize('sc-1')
    expect(held()?.status).toBe('failed')
    expect(held()?.error).toEqual({
      message: 'OpenAI is rate limiting this key.',
      nextStep: 'Wait a minute and try again.'
    })
    // The stored row it failed to replace is still shown.
    expect(held()?.summary).toEqual(ROW)
    expect(toasts()).toEqual([])
  })

  it('returns to the previous state in silence when the run is cancelled', async () => {
    gets = [state({ stale: true, summary: null })]
    results = [
      { ok: false, code: 'CANCELLED', message: 'Cancelled.', nextStep: '', requestId: 'req-1' }
    ]
    await store().load('sc-1')
    const before = held()
    await store().summarize('sc-1')
    expect(held()).toEqual(before)
    expect(toasts()).toEqual([])
  })

  it('toasts an unexpected failure and leaves the node as it was', async () => {
    install({
      'ai:summarize': () => {
        throw new IpcRequestError({ code: 'INTERNAL', message: 'The project is closed.' })
      }
    })
    await store().load('sc-1')
    const before = held()
    await store().summarize('sc-1')
    expect(held()).toEqual(before)
    expect(toasts()).toEqual(['The project is closed.'])
  })

  it('ignores a second Summarize now while one is on the way', async () => {
    install({ 'ai:summarize': () => new Promise<AiSummarizeResult>(() => {}) })
    await store().load('sc-1')
    void store().summarize('sc-1')
    await Promise.resolve()
    await Promise.resolve()
    calls = []
    await store().summarize('sc-1')
    expect(channels()).toEqual([])
  })

  it('shows a background run at once and refetches when it ends', async () => {
    await store().load('sc-1')
    calls = []
    listener?.({ nodeId: 'sc-1', status: 'pending' })
    expect(held()?.status).toBe('pending')
    expect(channels()).toEqual([])
    gets = [state({ summary: { ...ROW, summary: 'A newer summary.' } })]
    listener?.({ nodeId: 'sc-1', status: 'idle' })
    await Promise.resolve()
    await Promise.resolve()
    expect(channels()).toEqual(['summary:get'])
    expect(held()?.summary?.summary).toBe('A newer summary.')
    expect(held()?.status).toBe('idle')
  })

  it('ignores a change for a node nothing is holding', () => {
    listener?.({ nodeId: 'sc-9', status: 'failed' })
    expect(held('sc-9')).toBeUndefined()
    expect(channels()).toEqual([])
  })

  it('clear forgets every node and reset drops the subscription', async () => {
    await store().load('sc-1')
    store().clear()
    expect(store().byNode).toEqual({})
    expect(unsubscribes).toBe(0)
    resetSummaryStore()
    expect(unsubscribes).toBe(1)
    // The next load opens a fresh subscription.
    await store().load('sc-1')
    expect(subscriptions).toBe(2)
  })
})
