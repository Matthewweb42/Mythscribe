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

  it('merge upserts a row without an IPC call: a count moves in place, a new id or name re-sorts (F-4.4)', async () => {
    const { client, calls } = fakeClient()
    setIpcClient(client)
    await state().load()
    const idsBefore = state().ids
    state().merge({ ...tagFixture[2]!, usageCount: 4 })
    expect(state().byId['t-moody']?.usageCount).toBe(4)
    expect(state().ids).toBe(idsBefore)
    state().merge({ ...tagFixture[2]!, id: 't-eerie', name: 'eerie' })
    expect(state().ids).toEqual(['t-forest', 't-eerie', 't-mara', 't-moody'])
    state().merge({ ...tagFixture[1]!, name: 'zed' })
    expect(state().ids).toEqual(['t-forest', 't-eerie', 't-moody', 't-mara'])
    expect(calls.map(([channel]) => channel)).toEqual(['tag:list'])
  })

  it('requestSelection bumps the token for a repeat of the same tag; clear and clearSelectionRequest drop it (F-4.6)', () => {
    expect(state().pendingSelection).toBeNull()
    state().requestSelection('t-mara')
    expect(state().pendingSelection).toEqual({ id: 't-mara', token: 1 })
    state().requestSelection('t-mara')
    expect(state().pendingSelection).toEqual({ id: 't-mara', token: 2 })
    state().clearSelectionRequest()
    expect(state().pendingSelection).toBeNull()
    state().requestSelection('t-forest')
    expect(state().pendingSelection).toEqual({ id: 't-forest', token: 1 })
    state().clear()
    expect(state().pendingSelection).toBeNull()
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

  it('loadTemplate merges every created tag in one update, in name order, without re-listing', async () => {
    const created: Tag[] = [
      { ...tagFixture[2]!, id: 't-zeal', name: 'zeal', category: 'tone', usageCount: 0 },
      { ...tagFixture[2]!, id: 't-alpha', name: 'alpha', category: 'tone', usageCount: 0 }
    ]
    const answer = { created, skipped: ['moody'] }
    const { client, calls } = fakeClient({ 'tag:loadTemplate': () => answer })
    setIpcClient(client)
    await state().load()
    let updates = 0
    const unsubscribe = useTagStore.subscribe(() => updates++)
    const result = await state().loadTemplate('fantasy')
    unsubscribe()
    expect(result).toEqual(answer)
    expect(updates).toBe(1)
    expect(state().ids).toEqual(['t-alpha', 't-forest', 't-mara', 't-moody', 't-zeal'])
    expect(state().byId['t-zeal']).toEqual(created[0])
    expect(calls.at(-1)).toEqual(['tag:loadTemplate', { template: 'fantasy' }])
    expect(calls.filter(([channel]) => channel === 'tag:list')).toHaveLength(1)
  })

  it('loadTemplate with nothing created leaves the store untouched', async () => {
    setIpcClient(fakeClient({ 'tag:loadTemplate': () => ({ created: [], skipped: ['a'] }) }).client)
    await state().load()
    const before = state()
    await expect(state().loadTemplate('mystery')).resolves.toEqual({ created: [], skipped: ['a'] })
    expect(state().byId).toBe(before.byId)
    expect(state().ids).toBe(before.ids)
  })

  it('a failed loadTemplate propagates and leaves the store untouched', async () => {
    setIpcClient(fakeClient({ 'tag:loadTemplate': failure }).client)
    await state().load()
    const before = state()
    await expect(state().loadTemplate('sci-fi')).rejects.toBeInstanceOf(IpcRequestError)
    expect(state().byId).toBe(before.byId)
    expect(state().ids).toBe(before.ids)
  })

  it('a loadTemplate that resolves after clear does not repopulate the store', async () => {
    const created: Tag = { ...tagFixture[2]!, id: 't-late', name: 'late' }
    let release: (value: { created: Tag[]; skipped: string[] }) => void = () => {}
    const slow = new Promise<{ created: Tag[]; skipped: string[] }>((resolve) => {
      release = resolve
    })
    setIpcClient(fakeClient({ 'tag:loadTemplate': () => slow }).client)
    await state().load()
    const pending = state().loadTemplate('fantasy')
    state().clear()
    release({ created: [created], skipped: [] })
    await expect(pending).resolves.toEqual({ created: [created], skipped: [] })
    expect(state().ids).toEqual([])
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
