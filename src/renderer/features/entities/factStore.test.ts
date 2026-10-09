import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventPayload, Input, Output } from '@shared/ipc/contract'
import type { Fact } from '@shared/facts'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { factFixture } from './factFixture'
import { resetFactStore, useFactStore } from './factStore'

type Listener = (payload: EventPayload<'fact:changed'>) => void

/** Answers the fact channels from `rows` the way main does; records every call. */
function fakeClient(rows: Fact[]): {
  calls: [Channel, unknown][]
  emit: (entityIds: string[]) => void
} {
  const calls: [Channel, unknown][] = []
  const listeners: Listener[] = []
  const find = (id: string): Fact => {
    const row = rows.find((other) => other.id === id)
    if (!row) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'No such fact' })
    return row
  }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'fact:listForEntity') {
        const { entityId } = input as Input<'fact:listForEntity'>
        return rows.filter((row) => row.entityId === entityId) as Output<C>
      }
      if (channel === 'fact:setHidden') {
        const { id, hidden } = input as Input<'fact:setHidden'>
        return { ...find(id), hidden } as Output<C>
      }
      if (channel === 'fact:setStatus') {
        const { id, status } = input as Input<'fact:setStatus'>
        return { ...find(id), status } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel !== 'fact:changed') throw new Error(`unexpected subscription ${channel}`)
      listeners.push(listener as Listener)
      return () => {
        listeners.splice(listeners.indexOf(listener as Listener), 1)
      }
    }
  }
  setIpcClient(client)
  return {
    calls,
    emit: (entityIds) => {
      for (const listener of [...listeners]) listener({ entityIds })
    }
  }
}

const held = (entityId: string): Fact[] | undefined => useFactStore.getState().byEntity[entityId]

describe('factStore (F-9.13)', () => {
  beforeEach(() => resetFactStore())
  afterEach(() => resetFactStore())

  it('loads one record’s facts, hidden ones included', async () => {
    fakeClient(factFixture)
    await useFactStore.getState().load('e-mara')
    expect(held('e-mara')?.map((fact) => fact.id)).toEqual([
      'f-1',
      'f-2',
      'f-3',
      'f-4',
      'f-5',
      'f-6'
    ])
    expect(held('e-aldous')).toBeUndefined()
  })

  it('merges a hidden flag and a status main answers', async () => {
    const { calls } = fakeClient(factFixture)
    await useFactStore.getState().load('e-mara')
    await useFactStore.getState().setHidden(['f-1', 'f-2'], true)
    await useFactStore.getState().setStatus(['f-3'], 'idea')
    expect(
      held('e-mara')
        ?.filter((fact) => fact.hidden)
        .map((fact) => fact.id)
    ).toEqual(['f-1', 'f-2', 'f-6'])
    expect(held('e-mara')?.find((fact) => fact.id === 'f-3')?.status).toBe('idea')
    expect(calls.map(([channel]) => channel)).toEqual([
      'fact:listForEntity',
      'fact:setHidden',
      'fact:setHidden',
      'fact:setStatus'
    ])
    await expect(useFactStore.getState().setHidden(['missing'], true)).rejects.toThrow(
      'No such fact'
    )
  })

  it('re-reads only the records it holds when main says their facts changed', async () => {
    const { calls, emit } = fakeClient(factFixture)
    useFactStore.getState().subscribe()
    useFactStore.getState().subscribe()
    await useFactStore.getState().load('e-mara')
    emit(['e-mara', 'e-aldous'])
    await Promise.resolve()
    expect(calls.filter(([channel]) => channel === 'fact:listForEntity')).toEqual([
      ['fact:listForEntity', { entityId: 'e-mara' }],
      ['fact:listForEntity', { entityId: 'e-mara' }]
    ])
  })

  it('drops an answer for a project that closed', async () => {
    fakeClient(factFixture)
    const pending = useFactStore.getState().load('e-mara')
    useFactStore.getState().clear()
    await pending
    expect(held('e-mara')).toBeUndefined()
  })
})
