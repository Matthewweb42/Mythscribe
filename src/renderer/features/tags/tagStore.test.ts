import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { tagFixture } from './tagFixture'
import { orderedIds, resetTagStore, useTagStore } from './tagStore'

type Handler = (input: unknown) => unknown
type Listener = (tag: Tag) => void

/** Answers `tag:list` with the fixture, `tag:aliases` with none, and the mutations with `handlers`; records every call. */
function fakeClient(handlers: Partial<Record<Channel, Handler>> = {}): {
  client: IpcClient
  calls: [Channel, unknown][]
  listeners: Listener[]
  /** Pushes a `tag:changed` event (F-9.4) to whoever subscribed. */
  emit: (tag: Tag) => void
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
      if (channel !== 'tag:changed') throw new Error(`unexpected subscription ${channel}`)
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
    emit: (tag) => {
      for (const listener of [...listeners]) listener(tag)
    }
  }
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
    expect(calls.map(([channel]) => channel)).toEqual(['tag:list', 'tag:aliases'])
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

  it('subscribe merges a tag main created or renamed elsewhere, once (F-9.4)', async () => {
    const { client, listeners, emit } = fakeClient()
    setIpcClient(client)
    state().subscribe()
    state().subscribe()
    expect(listeners).toHaveLength(1)
    await state().load()

    const created: Tag = { ...tagFixture[1]!, id: 't-new', name: 'mara-vell' }
    emit(created)
    expect(state().byId['t-new']).toEqual(created)
    expect(state().ids).toEqual(['t-forest', 't-mara', 't-new', 't-moody'])

    // A rename of a tag already in the bank replaces it in place and re-sorts.
    emit({ ...tagFixture[0]!, name: 'zebra' })
    expect(state().byId['t-forest']?.name).toBe('zebra')
    expect(state().ids).toEqual(['t-mara', 't-new', 't-moody', 't-forest'])
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

describe('tagStore bulk operations (F-4.9)', () => {
  beforeEach(() => {
    resetTagStore()
  })

  it('load reads the aliases beside the bank, and clear drops them', async () => {
    setIpcClient(fakeClient({ 'tag:aliases': () => ({ 't-old': 't-mara' }) }).client)
    await state().load()
    expect(state().aliases).toEqual({ 't-old': 't-mara' })
    state().clear()
    expect(state().aliases).toEqual({})
  })

  it('recolorMany replaces every returned row in place without re-sorting', async () => {
    const answer = [
      { ...tagFixture[0]!, color: '#111111' },
      { ...tagFixture[2]!, color: '#111111' }
    ]
    const { client, calls } = fakeClient({ 'tag:recolor': () => answer })
    setIpcClient(client)
    await state().load()
    const idsBefore = state().ids
    await state().recolorMany(['t-forest', 't-moody'], '#111111')
    expect(state().byId['t-forest']?.color).toBe('#111111')
    expect(state().byId['t-moody']?.color).toBe('#111111')
    expect(state().byId['t-mara']?.color).toBe('#dc2626')
    expect(state().ids).toBe(idsBefore)
    expect(calls.at(-1)).toEqual([
      'tag:recolor',
      { ids: ['t-forest', 't-moody'], color: '#111111' }
    ])
  })

  it('removeMany drops the rows and the aliases that led to them', async () => {
    const { client, calls } = fakeClient({
      'tag:aliases': () => ({ 't-old': 't-mara', 't-older': 't-forest' }),
      'tag:deleteMany': () => null
    })
    setIpcClient(client)
    await state().load()
    await state().removeMany(['t-mara', 't-moody'])
    expect(state().ids).toEqual(['t-forest'])
    expect(state().byId['t-mara']).toBeUndefined()
    expect(state().aliases).toEqual({ 't-older': 't-forest' })
    expect(calls.at(-1)).toEqual(['tag:deleteMany', { ids: ['t-mara', 't-moody'] }])
  })

  it('mergeInto replaces the target, drops the merged tags, and stores main’s aliases', async () => {
    const target: Tag = { ...tagFixture[1]!, usageCount: 4 }
    const answer = {
      target,
      removedIds: ['t-forest', 't-moody'],
      aliases: { 't-forest': 't-mara', 't-moody': 't-mara' }
    }
    const { client, calls } = fakeClient({ 'tag:merge': () => answer })
    setIpcClient(client)
    await state().load()
    await state().mergeInto('t-mara', ['t-forest', 't-moody'])
    expect(state().ids).toEqual(['t-mara'])
    expect(state().byId['t-mara']?.usageCount).toBe(4)
    expect(state().aliases).toEqual(answer.aliases)
    expect(calls.at(-1)).toEqual([
      'tag:merge',
      { targetId: 't-mara', sourceIds: ['t-forest', 't-moody'] }
    ])
  })

  it('a failed recolorMany, removeMany, or mergeInto propagates and leaves the store untouched', async () => {
    setIpcClient(
      fakeClient({ 'tag:recolor': failure, 'tag:deleteMany': failure, 'tag:merge': failure }).client
    )
    await state().load()
    const before = state()
    await expect(state().recolorMany(['t-mara'], '#000000')).rejects.toBeInstanceOf(IpcRequestError)
    await expect(state().removeMany(['t-mara'])).rejects.toBeInstanceOf(IpcRequestError)
    await expect(state().mergeInto('t-mara', ['t-moody'])).rejects.toBeInstanceOf(IpcRequestError)
    expect(state().byId).toBe(before.byId)
    expect(state().ids).toBe(before.ids)
    expect(state().aliases).toBe(before.aliases)
  })

  it('importBank merges the created tags in name order; a cancel or nothing new leaves the store', async () => {
    const created: Tag[] = [{ ...tagFixture[2]!, id: 't-alpha', name: 'alpha', usageCount: 0 }]
    let answer: { created: Tag[]; skipped: string[] } | null = null
    const { client, calls } = fakeClient({ 'tag:import': () => answer })
    setIpcClient(client)
    await state().load()
    const before = state()
    await expect(state().importBank()).resolves.toBeNull()
    expect(state().ids).toBe(before.ids)
    expect(calls.at(-1)).toEqual(['tag:import', {}])

    answer = { created: [], skipped: ['mara'] }
    await expect(state().importBank()).resolves.toEqual(answer)
    expect(state().ids).toBe(before.ids)

    answer = { created, skipped: ['mara'] }
    await expect(state().importBank()).resolves.toEqual(answer)
    expect(state().ids).toEqual(['t-alpha', 't-forest', 't-mara', 't-moody'])
  })

  it('exportBank answers what main wrote, or null when cancelled', async () => {
    let answer: { path: string; count: number } | null = { path: '/x/Book tags.json', count: 3 }
    const { client, calls } = fakeClient({ 'tag:export': () => answer })
    setIpcClient(client)
    await expect(state().exportBank()).resolves.toEqual({ path: '/x/Book tags.json', count: 3 })
    expect(calls.at(-1)).toEqual(['tag:export', {}])
    answer = null
    await expect(state().exportBank()).resolves.toBeNull()
  })

  it('a mergeInto that resolves after clear does not repopulate the store', async () => {
    let release: (value: Output<'tag:merge'>) => void = () => {}
    const slow = new Promise<Output<'tag:merge'>>((resolve) => {
      release = resolve
    })
    setIpcClient(fakeClient({ 'tag:merge': () => slow }).client)
    await state().load()
    const pending = state().mergeInto('t-mara', ['t-moody'])
    state().clear()
    release({ target: tagFixture[1]!, removedIds: ['t-moody'], aliases: { 't-moody': 't-mara' } })
    await pending
    expect(state().ids).toEqual([])
    expect(state().aliases).toEqual({})
  })
})
