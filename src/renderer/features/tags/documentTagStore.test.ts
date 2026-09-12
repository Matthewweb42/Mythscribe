import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentTagStore, useDocumentTagStore } from './documentTagStore'
import { tagFixture } from './tagFixture'
import { resetTagStore, useTagStore } from './tagStore'

type Handler = (input: unknown) => unknown

/** Answers `tag:list` with the fixture and the document-tag channels with `handlers`; records every call. */
function fakeClient(handlers: Partial<Record<Channel, Handler>> = {}): {
  client: IpcClient
  calls: [Channel, unknown][]
} {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const handler = handlers[channel]
      if (handler) return handler(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, calls }
}

const forest = tagFixture[0]!
const mara = tagFixture[1]!

const state = (): ReturnType<typeof useDocumentTagStore.getState> => useDocumentTagStore.getState()
const bank = (): ReturnType<typeof useTagStore.getState> => useTagStore.getState()

describe('documentTagStore (F-4.4)', () => {
  beforeEach(() => {
    resetTagStore()
    resetDocumentTagStore()
  })

  it('load records the linked ids in list order and merges the fresh rows into the bank', async () => {
    const { client, calls } = fakeClient({
      'documentTag:list': () => [
        { ...forest, usageCount: 7 },
        { ...mara, usageCount: 2 }
      ]
    })
    setIpcClient(client)
    await bank().load()
    await state().load('sc-1')
    expect(state().tagIdsByNode['sc-1']).toEqual(['t-forest', 't-mara'])
    expect(bank().byId['t-forest']?.usageCount).toBe(7)
    expect(bank().byId['t-mara']?.usageCount).toBe(2)
    expect(bank().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    expect(calls.at(-1)).toEqual(['documentTag:list', { nodeId: 'sc-1' }])
  })

  it('add appends the id once and moves the usage count in the bank', async () => {
    const { client, calls } = fakeClient({
      'documentTag:list': () => [],
      'documentTag:add': () => ({ ...forest, usageCount: 4 })
    })
    setIpcClient(client)
    await bank().load()
    await state().load('sc-1')
    await state().add('sc-1', 't-forest')
    expect(state().tagIdsByNode['sc-1']).toEqual(['t-forest'])
    expect(bank().byId['t-forest']?.usageCount).toBe(4)
    await state().add('sc-1', 't-forest') // idempotent on main; stays a single chip here
    expect(state().tagIdsByNode['sc-1']).toEqual(['t-forest'])
    expect(calls.at(-1)).toEqual(['documentTag:add', { nodeId: 'sc-1', tagId: 't-forest' }])
    expect(calls.filter(([channel]) => channel === 'tag:list')).toHaveLength(1)
  })

  it('add on a node that was never loaded still records the link', async () => {
    setIpcClient(fakeClient({ 'documentTag:add': () => ({ ...mara, usageCount: 2 }) }).client)
    await bank().load()
    await state().add('sc-2', 't-mara')
    expect(state().tagIdsByNode['sc-2']).toEqual(['t-mara'])
  })

  it('remove drops the id and moves the usage count back', async () => {
    const { client, calls } = fakeClient({
      'documentTag:list': () => [forest, mara],
      'documentTag:remove': () => ({ ...forest, usageCount: 2 })
    })
    setIpcClient(client)
    await bank().load()
    await state().load('sc-1')
    await state().remove('sc-1', 't-forest')
    expect(state().tagIdsByNode['sc-1']).toEqual(['t-mara'])
    expect(bank().byId['t-forest']?.usageCount).toBe(2)
    expect(calls.at(-1)).toEqual(['documentTag:remove', { nodeId: 'sc-1', tagId: 't-forest' }])
  })

  it('a failed add or remove propagates and leaves the links untouched', async () => {
    const failure = (): never => {
      throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Tag not found' })
    }
    setIpcClient(
      fakeClient({
        'documentTag:list': () => [forest],
        'documentTag:add': failure,
        'documentTag:remove': failure
      }).client
    )
    await bank().load()
    await state().load('sc-1')
    const before = state().tagIdsByNode
    await expect(state().add('sc-1', 't-mara')).rejects.toThrow('Tag not found')
    await expect(state().remove('sc-1', 't-forest')).rejects.toBeInstanceOf(IpcRequestError)
    expect(state().tagIdsByNode).toBe(before)
    expect(bank().byId['t-forest']?.usageCount).toBe(3)
  })

  it('a superseded load of the same node is dropped; other nodes are unaffected', async () => {
    let releaseFirst: (tags: Tag[]) => void = () => {}
    let answers = 0
    setIpcClient(
      fakeClient({
        'documentTag:list': (input) => {
          const { nodeId } = input as Input<'documentTag:list'>
          if (nodeId === 'sc-2') return [mara]
          return ++answers === 1
            ? new Promise<Tag[]>((resolve) => {
                releaseFirst = resolve
              })
            : []
        }
      }).client
    )
    await bank().load()
    const stale = state().load('sc-1')
    await state().load('sc-1')
    await state().load('sc-2')
    releaseFirst([forest])
    await stale
    expect(state().tagIdsByNode['sc-1']).toEqual([])
    expect(state().tagIdsByNode['sc-2']).toEqual(['t-mara'])
  })

  it('clear empties the store and stops a pending load or mutation from applying', async () => {
    let release: (tags: Tag[]) => void = () => {}
    let releaseAdd: (tag: Tag) => void = () => {}
    setIpcClient(
      fakeClient({
        'documentTag:list': () =>
          new Promise<Tag[]>((resolve) => {
            release = resolve
          }),
        'documentTag:add': () =>
          new Promise<Tag>((resolve) => {
            releaseAdd = resolve
          })
      }).client
    )
    await bank().load()
    useDocumentTagStore.setState({ tagIdsByNode: { 'sc-9': ['t-moody'] } })
    const loading = state().load('sc-1')
    const adding = state().add('sc-1', 't-mara')
    state().clear()
    expect(state().tagIdsByNode).toEqual({})
    release([forest])
    releaseAdd({ ...mara, usageCount: 9 })
    await loading
    await adding
    expect(state().tagIdsByNode).toEqual({})
    expect(bank().byId['t-mara']?.usageCount).toBe(1)
  })
})
