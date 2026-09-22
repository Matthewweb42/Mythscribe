import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TagMentions } from '@shared/mentions'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetMentionStore, useMentionStore } from './mentionStore'

type Handler = (input: unknown) => unknown
type Listener = (payload: { nodeIds: string[] }) => void

/** Answers the mention channels with `handlers`; records every call and every subscription. */
function fakeClient(handlers: Partial<Record<Channel, Handler>> = {}): {
  client: IpcClient
  calls: [Channel, unknown][]
  listeners: Listener[]
  emit: (nodeIds: string[]) => void
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
      if (channel !== 'mention:changed') throw new Error(`unexpected subscription ${channel}`)
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
    emit: (nodeIds) => {
      for (const listener of [...listeners]) listener({ nodeIds })
    }
  }
}

const mention = (tagId: string, nodeId: string, count: number): TagMentions => ({
  tagId,
  nodeId,
  count,
  ranges: Array.from({ length: count }, (_value, i) => [10 * (i + 1), 10 * (i + 1) + 4])
})

const state = (): ReturnType<typeof useMentionStore.getState> => useMentionStore.getState()

describe('mentionStore (F-4.12)', () => {
  beforeEach(() => {
    resetMentionStore()
  })

  it('loads a tag’s documents and a document’s tags into their own maps', async () => {
    const { client, calls } = fakeClient({
      'mention:listForTag': () => [mention('t-mara', 'sc-1', 2), mention('t-mara', 'sc-2', 1)],
      'mention:listForNode': () => [mention('t-mara', 'sc-1', 2)]
    })
    setIpcClient(client)
    await state().loadForTag('t-mara')
    await state().loadForNode('sc-1')
    expect(state().byTag['t-mara']).toHaveLength(2)
    expect(state().byTag['t-mara']?.[0]).toMatchObject({ nodeId: 'sc-1', count: 2 })
    expect(state().byNode['sc-1']).toEqual([mention('t-mara', 'sc-1', 2)])
    expect(state().byNode['t-mara']).toBeUndefined()
    expect(calls).toEqual([
      ['mention:listForTag', { tagId: 't-mara' }],
      ['mention:listForNode', { nodeId: 'sc-1' }]
    ])
  })

  it('a failed load propagates and leaves the maps untouched', async () => {
    setIpcClient(
      fakeClient({
        'mention:listForTag': () => {
          throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Tag not found' })
        }
      }).client
    )
    await expect(state().loadForTag('t-gone')).rejects.toThrow('Tag not found')
    expect(state().byTag).toEqual({})
  })

  it('a superseded load of the same key is dropped; other keys are unaffected', async () => {
    let releaseFirst: (rows: TagMentions[]) => void = () => {}
    let answers = 0
    setIpcClient(
      fakeClient({
        'mention:listForNode': (input) => {
          const { nodeId } = input as Input<'mention:listForNode'>
          if (nodeId === 'sc-2') return [mention('t-moody', 'sc-2', 1)]
          return ++answers === 1
            ? new Promise<TagMentions[]>((resolve) => {
                releaseFirst = resolve
              })
            : []
        }
      }).client
    )
    const stale = state().loadForNode('sc-1')
    await state().loadForNode('sc-1')
    await state().loadForNode('sc-2')
    releaseFirst([mention('t-mara', 'sc-1', 9)])
    await stale
    expect(state().byNode['sc-1']).toEqual([])
    expect(state().byNode['sc-2']).toEqual([mention('t-moody', 'sc-2', 1)])
  })

  it('subscribe refetches the named loaded documents and every loaded tag, once', async () => {
    const { client, calls, listeners, emit } = fakeClient({
      'mention:listForTag': () => [mention('t-mara', 'sc-1', 3)],
      'mention:listForNode': (input) => {
        const { nodeId } = input as Input<'mention:listForNode'>
        return nodeId === 'sc-1' ? [mention('t-mara', 'sc-1', 3)] : []
      }
    })
    setIpcClient(client)
    state().subscribe()
    state().subscribe()
    expect(listeners).toHaveLength(1)
    await state().loadForTag('t-mara')
    await state().loadForNode('sc-1')
    const before = calls.length

    emit(['sc-1', 'sc-9'])
    await Promise.resolve()
    await Promise.resolve()
    // `sc-9` was never loaded, so nothing on screen waits for it.
    expect(calls.slice(before)).toEqual([
      ['mention:listForNode', { nodeId: 'sc-1' }],
      ['mention:listForTag', { tagId: 't-mara' }]
    ])
    expect(state().byNode['sc-9']).toBeUndefined()
    expect(state().byTag['t-mara']?.[0]?.count).toBe(3)
  })

  it('a refresh that fails leaves the rows the author already sees', async () => {
    let fail = false
    const { client, emit } = fakeClient({
      'mention:listForNode': () => {
        if (fail) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Document not found' })
        return [mention('t-mara', 'sc-1', 2)]
      }
    })
    setIpcClient(client)
    state().subscribe()
    await state().loadForNode('sc-1')
    fail = true
    emit(['sc-1'])
    await Promise.resolve()
    await Promise.resolve()
    expect(state().byNode['sc-1']).toEqual([mention('t-mara', 'sc-1', 2)])
  })

  it('clear empties both maps and stops a pending load from applying', async () => {
    let release: (rows: TagMentions[]) => void = () => {}
    setIpcClient(
      fakeClient({
        'mention:listForTag': () =>
          new Promise<TagMentions[]>((resolve) => {
            release = resolve
          })
      }).client
    )
    useMentionStore.setState({ byNode: { 'sc-9': [mention('t-moody', 'sc-9', 1)] } })
    const loading = state().loadForTag('t-mara')
    state().clear()
    expect(state().byNode).toEqual({})
    release([mention('t-mara', 'sc-1', 1)])
    await loading
    expect(state().byTag).toEqual({})
  })
})
