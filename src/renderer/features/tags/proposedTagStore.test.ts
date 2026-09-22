import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import type { ProposedTag } from '@shared/proposedTags'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetProposedTagStore, useProposedTagStore } from './proposedTagStore'
import { resetTagStore, useTagStore } from './tagStore'

type Handler = (input: unknown) => unknown
type Listener = (payload: ProposedTag[]) => void

/** Answers the proposal channels with `handlers`; records every call and every subscription. */
function fakeClient(handlers: Partial<Record<Channel, Handler>> = {}): {
  client: IpcClient
  calls: [Channel, unknown][]
  listeners: Listener[]
  emit: (proposals: ProposedTag[]) => void
} {
  const calls: [Channel, unknown][] = []
  const listeners: Listener[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const handler = handlers[channel]
      if (handler) return handler(input) as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel !== 'tag:proposedChanged') throw new Error(`unexpected subscription ${channel}`)
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
    emit: (proposals) => {
      for (const listener of [...listeners]) listener(proposals)
    }
  }
}

const proposal = (name: string, count: number): ProposedTag => ({
  name,
  display: name.charAt(0).toUpperCase() + name.slice(1),
  count,
  nodeIds: ['sc-1']
})

const tag = (name: string): Tag => ({
  id: `t-${name}`,
  name,
  category: 'character',
  color: '#dc2626',
  parentId: null,
  usageCount: 0,
  trackMentions: true,
  created: '2026-09-22T10:00:00.000Z',
  modified: '2026-09-22T10:00:00.000Z'
})

const state = (): ReturnType<typeof useProposedTagStore.getState> => useProposedTagStore.getState()

describe('proposedTagStore (F-4.12b)', () => {
  beforeEach(() => {
    resetProposedTagStore()
    resetTagStore()
  })

  it('loads the list main computed', async () => {
    const { client, calls } = fakeClient({
      'tag:proposed': () => [proposal('tash', 3), proposal('bren', 3)]
    })
    setIpcClient(client)
    await state().load()
    expect(state().proposals.map((p) => p.name)).toEqual(['tash', 'bren'])
    expect(calls).toEqual([['tag:proposed', undefined]])
  })

  it('a failed load propagates and leaves the list untouched', async () => {
    setIpcClient(
      fakeClient({
        'tag:proposed': () => {
          throw new IpcRequestError({ code: 'NO_PROJECT', message: 'No project is open' })
        }
      }).client
    )
    await expect(state().load()).rejects.toThrow('No project is open')
    expect(state().proposals).toEqual([])
  })

  it('subscribes once and takes every list main pushes', async () => {
    const { client, listeners, emit } = fakeClient({ 'tag:proposed': () => [proposal('tash', 3)] })
    setIpcClient(client)
    state().subscribe()
    state().subscribe()
    expect(listeners).toHaveLength(1)
    await state().load()
    emit([proposal('tash', 4), proposal('bren', 3)])
    expect(state().proposals.map((p) => p.count)).toEqual([4, 3])
    emit([])
    expect(state().proposals).toEqual([])
  })

  it('dismiss sends the name and takes the list main answers with', async () => {
    const { client, calls } = fakeClient({
      'tag:proposed': () => [proposal('tash', 3), proposal('bren', 3)],
      'tag:dismissProposed': () => [proposal('tash', 3)]
    })
    setIpcClient(client)
    await state().load()
    await state().dismiss('bren')
    expect(calls[1]).toEqual(['tag:dismissProposed', { name: 'bren' }])
    expect(state().proposals.map((p) => p.name)).toEqual(['tash'])
  })

  it('accept creates a character tag and merges it into the bank', async () => {
    const { client, calls } = fakeClient({ 'tag:create': () => tag('tash') })
    setIpcClient(client)
    useProposedTagStore.setState({ proposals: [proposal('tash', 3)] })
    const created = await state().accept('tash')
    expect(created.name).toBe('tash')
    expect(calls).toEqual([['tag:create', { name: 'tash', category: 'character' }]])
    expect(useTagStore.getState().byId['t-tash']?.name).toBe('tash')
    // Main drops the accepted name from the next list it pushes; nothing is guessed here.
    expect(state().proposals.map((p) => p.name)).toEqual(['tash'])
  })

  it('a failed accept leaves the proposal where the author saw it', async () => {
    setIpcClient(
      fakeClient({
        'tag:create': () => {
          throw new IpcRequestError({ code: 'ALREADY_EXISTS', message: 'Tag already exists' })
        }
      }).client
    )
    useProposedTagStore.setState({ proposals: [proposal('tash', 3)] })
    await expect(state().accept('tash')).rejects.toThrow('Tag already exists')
    expect(state().proposals.map((p) => p.name)).toEqual(['tash'])
  })

  it('clear empties the list and stops a pending load from applying', async () => {
    let release: (proposals: ProposedTag[]) => void = () => {}
    setIpcClient(
      fakeClient({
        'tag:proposed': () =>
          new Promise<ProposedTag[]>((resolve) => {
            release = resolve
          })
      }).client
    )
    useProposedTagStore.setState({ proposals: [proposal('bren', 3)] })
    const loading = state().load()
    state().clear()
    expect(state().proposals).toEqual([])
    release([proposal('tash', 3)])
    await loading
    expect(state().proposals).toEqual([])
  })
})
