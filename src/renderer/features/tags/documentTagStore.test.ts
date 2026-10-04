import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, DocumentTag, Input, Output } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentTagStore, useDocumentTagStore } from './documentTagStore'
import { tagFixture } from './tagFixture'
import { resetTagStore, useTagStore } from './tagStore'

type Handler = (input: unknown) => unknown
type Listener = (payload: { nodeIds: string[] }) => void

/**
 * Answers `tag:list` with the fixture and the document-tag channels with `handlers`; records
 * every call, and lets a test push `documentTag:changed` (F-4.13) to whoever subscribed.
 */
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
      if (channel === 'tag:list') return tagFixture as Output<C>
      if (channel === 'tag:aliases') return {} as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, listener) => {
      if (channel !== 'documentTag:changed') throw new Error(`unexpected subscription ${channel}`)
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

const forest = tagFixture[0]!
const mara = tagFixture[1]!
const moody = tagFixture[2]!
/** A tag as `documentTag:list` answers it: with the source of its link (F-4.13). */
const link = (
  tag: (typeof tagFixture)[number],
  source: DocumentTag['source'] = 'author'
): DocumentTag => ({
  ...tag,
  source
})
/** Lets the refreshes an event started (fire-and-forget in the store) land. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
        link({ ...forest, usageCount: 7 }),
        link({ ...mara, usageCount: 2 })
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
      'documentTag:list': () => [link(forest), link(mara)],
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
        'documentTag:list': () => [link(forest)],
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

  it('loadAll groups every link per node and blanks the nodes that lost theirs (F-4.10)', async () => {
    const { client, calls } = fakeClient({
      'documentTag:list': () => [link(forest)],
      'documentTag:listAll': () => [
        { nodeId: 'sc-1', tagId: 't-forest' },
        { nodeId: 'sc-1', tagId: 't-mara' },
        { nodeId: 'ch-2', tagId: 't-moody' }
      ]
    })
    setIpcClient(client)
    await bank().load()
    await state().load('sc-2') // loaded once, no link left: it must come back empty, not stale
    useDocumentTagStore.setState({ tagIdsByNode: { ...state().tagIdsByNode, 'sc-2': ['t-moody'] } })
    await state().loadAll()
    expect(state().tagIdsByNode).toEqual({
      'sc-1': ['t-forest', 't-mara'],
      'sc-2': [],
      'ch-2': ['t-moody']
    })
    expect(calls.at(-1)).toEqual(['documentTag:listAll', undefined])
  })

  it('loadAll after a clear is dropped', async () => {
    let release: (links: { nodeId: string; tagId: string }[]) => void = () => {}
    setIpcClient(
      fakeClient({
        'documentTag:listAll': () =>
          new Promise<{ nodeId: string; tagId: string }[]>((resolve) => {
            release = resolve
          })
      }).client
    )
    await bank().load()
    const loading = state().loadAll()
    state().clear()
    release([{ nodeId: 'sc-1', tagId: 't-forest' }])
    await loading
    expect(state().tagIdsByNode).toEqual({})
  })

  it('a superseded load of the same node is dropped; other nodes are unaffected', async () => {
    let releaseFirst: (tags: DocumentTag[]) => void = () => {}
    let answers = 0
    setIpcClient(
      fakeClient({
        'documentTag:list': (input) => {
          const { nodeId } = input as Input<'documentTag:list'>
          if (nodeId === 'sc-2') return [link(mara)]
          return ++answers === 1
            ? new Promise<DocumentTag[]>((resolve) => {
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
    releaseFirst([link(forest)])
    await stale
    expect(state().tagIdsByNode['sc-1']).toEqual([])
    expect(state().tagIdsByNode['sc-2']).toEqual(['t-mara'])
  })

  it('clear empties the store and stops a pending load or mutation from applying', async () => {
    let release: (tags: DocumentTag[]) => void = () => {}
    let releaseAdd: (tag: typeof mara) => void = () => {}
    setIpcClient(
      fakeClient({
        'documentTag:list': () =>
          new Promise<DocumentTag[]>((resolve) => {
            release = resolve
          }),
        'documentTag:add': () =>
          new Promise<typeof mara>((resolve) => {
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
    release([link(forest, 'ai')])
    releaseAdd({ ...mara, usageCount: 9 })
    await loading
    await adding
    expect(state().tagIdsByNode).toEqual({})
    expect(state().aiTagIdsByNode).toEqual({})
    expect(bank().byId['t-mara']?.usageCount).toBe(1)
  })

  describe('links the background job made (F-4.13)', () => {
    it('load records which links are AI-made and keeps the source out of the bank', async () => {
      setIpcClient(
        fakeClient({
          'documentTag:list': () => [link(forest), link(mara, 'ai'), link(moody, 'ai')]
        }).client
      )
      await bank().load()
      await state().load('sc-1')
      expect(state().tagIdsByNode['sc-1']).toEqual(['t-forest', 't-mara', 't-moody'])
      expect(state().aiTagIdsByNode['sc-1']).toEqual(['t-mara', 't-moody'])
      expect(bank().byId['t-mara']).toEqual(mara)
      expect(bank().byId['t-mara']).not.toHaveProperty('source')
    })

    it("add makes an AI-made link the author's; remove drops it from both lists", async () => {
      setIpcClient(
        fakeClient({
          'documentTag:list': () => [link(mara, 'ai'), link(moody, 'ai')],
          'documentTag:add': () => mara,
          'documentTag:remove': () => ({ ...moody, usageCount: 0 })
        }).client
      )
      await bank().load()
      await state().load('sc-1')
      await state().add('sc-1', 't-mara')
      expect(state().tagIdsByNode['sc-1']).toEqual(['t-mara', 't-moody'])
      expect(state().aiTagIdsByNode['sc-1']).toEqual(['t-moody'])
      await state().remove('sc-1', 't-moody')
      expect(state().tagIdsByNode['sc-1']).toEqual(['t-mara'])
      expect(state().aiTagIdsByNode['sc-1']).toEqual([])
    })

    it('loadAll leaves the AI lists of the loaded nodes alone', async () => {
      setIpcClient(
        fakeClient({
          'documentTag:list': () => [link(mara, 'ai')],
          'documentTag:listAll': () => [
            { nodeId: 'sc-1', tagId: 't-mara' },
            { nodeId: 'sc-2', tagId: 't-forest' }
          ]
        }).client
      )
      await bank().load()
      await state().load('sc-1')
      await state().loadAll()
      expect(state().aiTagIdsByNode).toEqual({ 'sc-1': ['t-mara'] })
      expect(state().tagIdsByNode['sc-2']).toEqual(['t-forest'])
    })

    it('subscribe lists the named loaded nodes again, once, and not the whole project', async () => {
      let answer: DocumentTag[] = [link(forest)]
      const { client, calls, listeners, emit } = fakeClient({ 'documentTag:list': () => answer })
      setIpcClient(client)
      state().subscribe()
      state().subscribe()
      expect(listeners).toHaveLength(1)
      await bank().load()
      await state().load('sc-1')
      calls.length = 0
      answer = [link(forest), link(moody, 'ai')]
      emit(['sc-1', 'sc-9'])
      await settled()
      expect(calls).toEqual([['documentTag:list', { nodeId: 'sc-1' }]])
      expect(state().tagIdsByNode['sc-1']).toEqual(['t-forest', 't-moody'])
      expect(state().aiTagIdsByNode['sc-1']).toEqual(['t-moody'])
      expect(state().tagIdsByNode['sc-9']).toBeUndefined()
    })

    it('an event refreshes the project-wide map once loadAll has run, until the project closes', async () => {
      let all = [{ nodeId: 'sc-1', tagId: 't-forest' }]
      const { client, calls, emit } = fakeClient({ 'documentTag:listAll': () => all })
      setIpcClient(client)
      state().subscribe()
      await state().loadAll()
      all = [...all, { nodeId: 'sc-3', tagId: 't-moody' }]
      calls.length = 0
      emit(['sc-3'])
      await settled()
      expect(calls).toContainEqual(['documentTag:listAll', undefined])
      expect(state().tagIdsByNode['sc-3']).toEqual(['t-moody'])
      state().clear()
      calls.length = 0
      emit(['sc-3'])
      await settled()
      expect(calls).toEqual([])
    })

    it('a refresh that fails is swallowed and leaves the links as they were', async () => {
      let fail = false
      const { client, emit } = fakeClient({
        'documentTag:list': () => {
          if (fail) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'Node not found' })
          return [link(mara, 'ai')]
        }
      })
      setIpcClient(client)
      state().subscribe()
      await bank().load()
      await state().load('sc-1')
      fail = true
      emit(['sc-1'])
      await settled()
      expect(state().tagIdsByNode['sc-1']).toEqual(['t-mara'])
      expect(state().aiTagIdsByNode['sc-1']).toEqual(['t-mara'])
    })
  })
})
