import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDLE_INDEX_QUEUE, type IndexQueueStatus } from '@shared/jobs'
import type {
  Channel,
  EventName,
  EventPayload,
  Input,
  JobsIndexAllResult,
  Output
} from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetIndexingStore, useIndexingStore } from './indexingStore'

type Handler = (input: unknown) => unknown

const BUSY: IndexQueueStatus = {
  queued: 2,
  running: { kind: 'summary', nodeId: 'sc-1' },
  failed: 0,
  done: 1,
  paused: null
}

const PAUSED: IndexQueueStatus = {
  queued: 3,
  running: null,
  failed: 0,
  done: 0,
  paused: { code: 'NO_KEY', message: 'No API key is saved.', nextStep: 'Add a key above.' }
}

let calls: [Channel, unknown][]
let listener: ((payload: EventPayload<'jobs:changed'>) => void) | null
let subscriptions: number
let statuses: IndexQueueStatus[]
let indexAllResults: JobsIndexAllResult[]

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return (await override(input)) as Output<C>
      if (channel === 'jobs:status') return (statuses.shift() ?? IDLE_INDEX_QUEUE) as Output<C>
      if (channel === 'jobs:cancel') return IDLE_INDEX_QUEUE as Output<C>
      if (channel === 'jobs:resume') return (statuses.shift() ?? IDLE_INDEX_QUEUE) as Output<C>
      if (channel === 'jobs:indexAll') {
        return (indexAllResults.shift() ?? {
          ok: true,
          queued: 0,
          status: IDLE_INDEX_QUEUE
        }) as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void) {
      if (event === 'jobs:changed') {
        subscriptions += 1
        listener = fn as (payload: EventPayload<'jobs:changed'>) => void
      }
      return () => {
        listener = null
      }
    }
  }
  setIpcClient(client)
}

const store = (): ReturnType<typeof useIndexingStore.getState> => useIndexingStore.getState()
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const channels = (): Channel[] => calls.map(([channel]) => channel)

beforeEach(() => {
  calls = []
  statuses = []
  indexAllResults = []
  listener = null
  subscriptions = 0
  resetIndexingStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})

afterEach(() => {
  resetIndexingStore()
  setIpcClient(null)
})

describe('indexingStore (F-5.13)', () => {
  it('starts idle and loads the queue, opening the change subscription once', async () => {
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
    statuses = [BUSY, IDLE_INDEX_QUEUE]
    await store().load()
    await store().load()
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
    expect(subscriptions).toBe(1)
    expect(channels()).toEqual(['jobs:status', 'jobs:status'])
  })

  it('follows main: every change event replaces the status', async () => {
    await store().load()
    listener?.(BUSY)
    expect(store().status).toEqual(BUSY)
    listener?.(IDLE_INDEX_QUEUE)
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
  })

  it('toasts a failed load and stays idle', async () => {
    install({
      'jobs:status': () => {
        throw new IpcRequestError({ code: 'NO_PROJECT', message: 'No project is open' })
      }
    })
    await store().load()
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
    expect(toasts()).toEqual(['No project is open'])
  })

  it('cancels and holds the empty queue main answers with', async () => {
    await store().load()
    listener?.(BUSY)
    await store().cancel()
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
    expect(channels()).toContain('jobs:cancel')
  })

  it('retries a paused queue', async () => {
    await store().load()
    listener?.(PAUSED)
    statuses = [{ ...PAUSED, paused: null }]
    await store().resume()
    expect(store().status.paused).toBeNull()
    expect(channels()).toContain('jobs:resume')
  })

  it('queues every stale scene and says how many', async () => {
    indexAllResults = [{ ok: true, queued: 3, status: BUSY }]
    await store().indexAll()
    expect(store().status).toEqual(BUSY)
    expect(toasts()).toEqual(['Queued 3 scenes for a summary.'])
  })

  it('counts one scene in the singular', async () => {
    indexAllResults = [{ ok: true, queued: 1, status: BUSY }]
    await store().indexAll()
    expect(toasts()).toEqual(['Queued 1 scene for a summary.'])
  })

  it('says so when every scene is already up to date', async () => {
    indexAllResults = [{ ok: true, queued: 0, status: IDLE_INDEX_QUEUE }]
    await store().indexAll()
    expect(toasts()).toEqual(['Every scene is up to date.'])
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
  })

  it('toasts the refusal with its next step and changes nothing', async () => {
    indexAllResults = [
      {
        ok: false,
        code: 'DISABLED',
        message: 'Scene summaries is turned off for this project.',
        nextStep: 'Turn the AI dial up in Settings, or enable the feature there.'
      }
    ]
    await store().indexAll()
    expect(toasts()).toEqual([
      'Scene summaries is turned off for this project. Turn the AI dial up in Settings, or enable the feature there.'
    ])
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
  })

  it('forgets the queue when the project closes', async () => {
    await store().load()
    listener?.(BUSY)
    store().clear()
    expect(store().status).toEqual(IDLE_INDEX_QUEUE)
  })
})
