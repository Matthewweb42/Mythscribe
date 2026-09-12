import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { tagFixture } from './tagFixture'
import { orderedIds, resetTagStore, useTagStore } from './tagStore'

type Handler = (input: unknown) => unknown

/** Answers `tag:list` with the fixture and the mutations with `handlers`; records every call. */
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

const failure = (): never => {
  throw new IpcRequestError({ code: 'ALREADY_EXISTS', message: 'A tag named "mara" exists' })
}

const state = (): ReturnType<typeof useTagStore.getState> => useTagStore.getState()

describe('tagStore (F-4.2)', () => {
  beforeEach(() => {
    resetTagStore()
  })

  it('orderedIds sorts by name, then id', () => {
    const byId: Record<string, Tag> = {
      b: { ...tagFixture[0]!, id: 'b', name: 'zeta' },
      a: { ...tagFixture[0]!, id: 'a', name: 'zeta' },
      c: { ...tagFixture[0]!, id: 'c', name: 'alpha' }
    }
    expect(orderedIds(byId)).toEqual(['c', 'a', 'b'])
  })

  it('load populates byId and ids in list order', async () => {
    setIpcClient(fakeClient().client)
    expect(state().loaded).toBe(false)
    await state().load()
    expect(state().loaded).toBe(true)
    expect(state().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    expect(state().byId['t-mara']?.category).toBe('character')
  })

  it('a load superseded by clear is dropped', async () => {
    let release: (tags: Tag[]) => void = () => {}
    const slow = new Promise<Tag[]>((resolve) => {
      release = resolve
    })
    setIpcClient(fakeClient({ 'tag:list': () => slow }).client)
    const pending = state().load()
    state().clear()
    release(tagFixture)
    await pending
    expect(state().loaded).toBe(false)
    expect(state().ids).toEqual([])
  })

  it('create merges the returned row in name order without re-listing', async () => {
    const created: Tag = {
      ...tagFixture[2]!,
      id: 't-eerie',
      name: 'eerie',
      category: 'tone',
      usageCount: 0
    }
    const { client, calls } = fakeClient({ 'tag:create': () => created })
    setIpcClient(client)
    await state().load()
    const result = await state().create({ name: 'Eerie', category: 'tone' })
    expect(result).toEqual(created)
    expect(state().ids).toEqual(['t-forest', 't-eerie', 't-mara', 't-moody'])
    expect(state().byId['t-eerie']).toEqual(created)
    expect(calls.filter(([channel]) => channel === 'tag:list')).toHaveLength(1)
    expect(calls.at(-1)).toEqual(['tag:create', { name: 'Eerie', category: 'tone' }])
  })

  it('update replaces the row in place and re-sorts when the name changes', async () => {
    const recolored: Tag = { ...tagFixture[1]!, color: '#000000' }
    const renamed: Tag = { ...tagFixture[1]!, name: 'zed' }
    let answer = recolored
    const { client, calls } = fakeClient({ 'tag:update': () => answer })
    setIpcClient(client)
    await state().load()
    const idsBefore = state().ids

    await state().update('t-mara', { color: '#000000' })
    expect(state().byId['t-mara']?.color).toBe('#000000')
    expect(state().ids).toBe(idsBefore) // the same array: nothing to re-sort
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', color: '#000000' }])

    answer = renamed
    await state().update('t-mara', { name: 'Zed' })
    expect(state().byId['t-mara']?.name).toBe('zed')
    expect(state().ids).toEqual(['t-forest', 't-moody', 't-mara'])
    expect(calls.filter(([channel]) => channel === 'tag:list')).toHaveLength(1)
  })

  it('remove drops the row', async () => {
    const { client, calls } = fakeClient({ 'tag:delete': () => null })
    setIpcClient(client)
    await state().load()
    await state().remove('t-mara')
    expect(state().ids).toEqual(['t-forest', 't-moody'])
    expect(state().byId['t-mara']).toBeUndefined()
    expect(calls.at(-1)).toEqual(['tag:delete', { id: 't-mara' }])
  })

  it('a failed create, update, or delete propagates and leaves the store untouched', async () => {
    setIpcClient(
      fakeClient({ 'tag:create': failure, 'tag:update': failure, 'tag:delete': failure }).client
    )
    await state().load()
    const before = state()
    await expect(state().create({ name: 'Mara', category: 'character' })).rejects.toThrow(
      'A tag named "mara" exists'
    )
    await expect(state().update('t-moody', { name: 'Mara' })).rejects.toBeInstanceOf(
      IpcRequestError
    )
    await expect(state().remove('t-moody')).rejects.toBeInstanceOf(IpcRequestError)
    expect(state().byId).toBe(before.byId)
    expect(state().ids).toBe(before.ids)
  })

  it('a mutation that resolves after clear does not repopulate the store', async () => {
    const created: Tag = { ...tagFixture[2]!, id: 't-late', name: 'late' }
    let release: (tag: Tag) => void = () => {}
    const slow = new Promise<Tag>((resolve) => {
      release = resolve
    })
    setIpcClient(fakeClient({ 'tag:create': () => slow }).client)
    await state().load()
    const pending = state().create({ name: 'Late', category: 'tone' })
    state().clear()
    release(created)
    await expect(pending).resolves.toEqual(created)
    expect(state().ids).toEqual([])
  })
})
