import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { ObservedFact } from '@shared/observedFacts'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { observedFactFixture } from './observedFactFixture'
import { resetObservedFactStore, useObservedFactStore } from './observedFactStore'

type Handler = (input: unknown) => unknown
type Listener = (payload: EventPayload<'observedFact:changed'>) => void

/** Answers the two fact channels from `rows` the way main does; records every call. */
function fakeClient(
  rows: ObservedFact[],
  handlers: Partial<Record<Channel, Handler>> = {}
): {
  client: IpcClient
  calls: [Channel, unknown][]
  listeners: Listener[]
  emit: (entityIds: string[]) => void
} {
  const calls: [Channel, unknown][] = []
  const listeners: Listener[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const handler = handlers[channel]
      if (handler) return handler(input) as Output<C>
      if (channel === 'observedFact:listForEntity') {
        const { entityId } = input as Input<'observedFact:listForEntity'>
        return rows.filter((row) => row.entityId === entityId) as Output<C>
      }
      if (channel === 'observedFact:setHidden') {
        const { id, hidden } = input as Input<'observedFact:setHidden'>
        const row = rows.find((other) => other.id === id)
        if (!row) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'No such fact' })
        return { ...row, hidden } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel !== 'observedFact:changed') throw new Error(`unexpected subscription ${channel}`)
      listeners.push(listener as Listener)
      return () => {
        listeners.splice(listeners.indexOf(listener as Listener), 1)
      }
    }
  }
  return {
    client,
    calls,
    listeners,
    emit: (entityIds) => {
      for (const listener of [...listeners]) listener({ entityIds })
    }
  }
}

const state = (): ReturnType<typeof useObservedFactStore.getState> =>
  useObservedFactStore.getState()
const idsOf = (entityId: string): string[] | undefined =>
  state().byEntity[entityId]?.map((fact) => fact.id)

describe('observedFactStore (F-5.16)', () => {
  beforeEach(() => {
    resetObservedFactStore()
  })
  afterEach(() => {
    resetObservedFactStore()
  })

  it('load holds one entity’s facts, the hidden ones included, and leaves the others alone', async () => {
    const { client, calls } = fakeClient(observedFactFixture)
    setIpcClient(client)
    await state().load('e-mara')
    expect(calls).toEqual([['observedFact:listForEntity', { entityId: 'e-mara' }]])
    expect(idsOf('e-mara')).toEqual(['f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6'])
    expect(state().byEntity['e-mara']?.find((fact) => fact.id === 'f-6')?.hidden).toBe(true)
    expect(idsOf('e-aldous')).toBeUndefined()
  })

  it('an older answer for the same entity is dropped, and so is one that lands after clear', async () => {
    const releases: ((rows: ObservedFact[]) => void)[] = []
    const { client } = fakeClient([], {
      'observedFact:listForEntity': () =>
        new Promise<ObservedFact[]>((resolve) => {
          releases.push(resolve)
        })
    })
    setIpcClient(client)
    const first = state().load('e-mara')
    const second = state().load('e-mara')
    releases[1]?.([observedFactFixture[3]!])
    releases[0]?.([observedFactFixture[0]!])
    await Promise.all([first, second])
    expect(idsOf('e-mara')).toEqual(['f-4'])

    const third = state().load('e-aldous')
    state().clear()
    releases[2]?.([observedFactFixture[6]!])
    await third
    expect(state().byEntity).toEqual({})
  })

  it('setHidden writes every id of the row and merges each answer', async () => {
    const { client, calls } = fakeClient(observedFactFixture)
    setIpcClient(client)
    await state().load('e-mara')
    await state().setHidden(['f-1', 'f-2'], true)
    expect(calls.slice(1)).toEqual([
      ['observedFact:setHidden', { id: 'f-1', hidden: true }],
      ['observedFact:setHidden', { id: 'f-2', hidden: true }]
    ])
    const hidden = state()
      .byEntity['e-mara']?.filter((fact) => fact.hidden)
      .map((fact) => fact.id)
    expect(hidden).toEqual(['f-1', 'f-2', 'f-6'])

    await state().setHidden(['f-6'], false)
    expect(state().byEntity['e-mara']?.find((fact) => fact.id === 'f-6')?.hidden).toBe(false)
  })

  it('a failed setHidden propagates and keeps what was written before it', async () => {
    const { client } = fakeClient(observedFactFixture)
    setIpcClient(client)
    await state().load('e-mara')
    await expect(state().setHidden(['f-1', 'f-gone', 'f-2'], true)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    const facts = state().byEntity['e-mara'] ?? []
    expect(facts.find((fact) => fact.id === 'f-1')?.hidden).toBe(true)
    expect(facts.find((fact) => fact.id === 'f-2')?.hidden).toBe(false)
  })

  it('subscribe re-reads only the entities it holds when main says they changed, once', async () => {
    const rows = observedFactFixture.slice(0, 5)
    const { client, calls, listeners, emit } = fakeClient(rows)
    setIpcClient(client)
    state().subscribe()
    state().subscribe()
    expect(listeners).toHaveLength(1)
    await state().load('e-mara')

    rows.push(observedFactFixture[5]!)
    emit(['e-mara', 'e-aldous'])
    await expect.poll(() => idsOf('e-mara')?.length).toBe(6)
    expect(calls.map(([, input]) => input)).toEqual([
      { entityId: 'e-mara' },
      { entityId: 'e-mara' }
    ])

    resetObservedFactStore()
    expect(listeners).toHaveLength(0)
  })
})
