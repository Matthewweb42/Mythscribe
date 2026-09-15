import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, ProvenanceReport } from '@shared/ipc/contract'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetProvenanceStore, useProvenanceStore } from './provenanceStore'

const REPORT: ProvenanceReport = {
  projectPercent: 25,
  aiChars: 100,
  totalChars: 400,
  documents: [
    { id: 'scene-1', title: 'Scene 1', aiChars: 100, totalChars: 400, percent: 25, proposals: 1 }
  ]
}

interface Fake {
  client: IpcClient
  calls: { channel: Channel; input: unknown }[]
  /** What `provenance:export` answers; null is a cancelled dialog. */
  exportAnswer: { path: string } | null
  /** Waits for a `provenance:report` to be on the wire (the store flushes first), then answers every pending one. */
  releaseReport: () => Promise<void>
}

function fakeClient(): Fake {
  const calls: Fake['calls'] = []
  let pending: (() => void)[] = []
  const fake: Fake = {
    calls,
    exportAnswer: { path: '/tmp/Book-ai-disclosure.md' },
    releaseReport: async () => {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
      const release = pending
      pending = []
      for (const fn of release) fn()
    },
    client: {
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push({ channel, input })
        switch (channel) {
          case 'provenance:report':
            await new Promise<void>((resolve) => pending.push(resolve))
            return REPORT as Output<C>
          case 'provenance:export':
            return fake.exportAnswer as Output<C>
          default:
            throw new Error(`unexpected ${channel}`)
        }
      },
      on: () => () => {}
    }
  }
  return fake
}

let fake: Fake
const store = (): ReturnType<typeof useProvenanceStore.getState> => useProvenanceStore.getState()

beforeEach(() => {
  resetProvenanceStore()
  fake = fakeClient()
  setIpcClient(fake.client)
})

describe('provenanceStore (F-14.6)', () => {
  it('starts empty and loads the report after flushing pending saves', async () => {
    const order: string[] = []
    const unregister = registerPendingSave(async () => {
      order.push('flush')
    })
    try {
      expect(store().report).toBeNull()
      const loading = store().load()
      await fake.releaseReport()
      await loading
      expect(store().report).toEqual(REPORT)
      expect(order).toEqual(['flush'])
      expect(fake.calls).toEqual([{ channel: 'provenance:report', input: undefined }])
    } finally {
      unregister()
    }
  })

  it('exportReport answers the path, or null when the dialog was cancelled', async () => {
    expect(await store().exportReport()).toBe('/tmp/Book-ai-disclosure.md')
    fake.exportAnswer = null
    expect(await store().exportReport()).toBeNull()
    expect(fake.calls.map((c) => c.channel)).toEqual(['provenance:export', 'provenance:export'])
  })

  it('lets a refused request propagate and changes nothing', async () => {
    fake.client.invoke = () => Promise.reject(new Error('nope'))
    await expect(store().load()).rejects.toThrow('nope')
    await expect(store().exportReport()).rejects.toThrow('nope')
    expect(store().report).toBeNull()
  })

  it('clear empties the store and drops a response that arrives afterwards', async () => {
    const late = store().load()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    store().clear()
    await fake.releaseReport()
    await late
    expect(store().report).toBeNull()
    const again = store().load()
    await fake.releaseReport()
    await again
    expect(store().report).toEqual(REPORT)
    store().clear()
    expect(store().report).toBeNull()
  })
})
