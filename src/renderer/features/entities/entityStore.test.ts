import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { entityFixture } from './entityFixture'
import { orderedIds, resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

/** Answers `entity:list` with the fixture and the mutations with `handlers`; records every call. */
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
      if (channel === 'entity:list') return entityFixture as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  return { client, calls }
}

const failure = (): never => {
  throw new IpcRequestError({ code: 'ALREADY_EXISTS', message: 'A character named "Mara" exists' })
}

const state = (): ReturnType<typeof useEntityStore.getState> => useEntityStore.getState()

const mara = entityFixture[1]!

describe('entityStore (F-9.2)', () => {
  beforeEach(() => {
    resetEntityStore()
  })

  it('orderedIds sorts by kind, then name key, then id', () => {
    const byId: Record<string, Entity> = {}
    const rows: Entity[] = [
      { ...mara, id: 'w', kind: 'world', name: 'alpha' },
      { ...mara, id: 'c2', kind: 'character', name: '  zed ' },
      { ...mara, id: 'c1', kind: 'character', name: 'Zed' },
      { ...mara, id: 's', kind: 'setting', name: 'Beta' },
      { ...mara, id: 'c0', kind: 'character', name: 'ada' }
    ]
    for (const row of rows) byId[row.id] = row
    expect(orderedIds(byId)).toEqual(['c0', 'c1', 'c2', 's', 'w'])
  })

  it('load fills the bank in list order', async () => {
    setIpcClient(fakeClient().client)
    await state().load()
    expect(state().loaded).toBe(true)
    expect(state().ids).toEqual(['e-aldous', 'e-mara', 'e-forest', 'e-blood', 'e-guild'])
    expect(state().byId['e-mara']).toEqual(mara)
  })

  it('a load superseded by clear is dropped', async () => {
    let release: (() => void) | undefined
    const { client } = fakeClient({
      'entity:list': () =>
        new Promise<Entity[]>((resolve) => {
          release = () => resolve(entityFixture)
        })
    })
    setIpcClient(client)
    const loading = state().load()
    state().clear()
    release?.()
    await loading
    expect(state().loaded).toBe(false)
    expect(state().ids).toEqual([])
  })

  it('create merges the returned row into its place and resolves with it', async () => {
    const created: Entity = { ...mara, id: 'e-bram', name: 'Bram', fields: {} }
    const { client, calls } = fakeClient({ 'entity:create': () => created })
    setIpcClient(client)
    await state().load()
    const result = await state().create({ kind: 'character', name: 'Bram', template: 'structured' })
    expect(result).toEqual(created)
    expect(calls.at(-1)).toEqual([
      'entity:create',
      { kind: 'character', name: 'Bram', template: 'structured' }
    ])
    expect(state().ids).toEqual(['e-aldous', 'e-bram', 'e-mara', 'e-forest', 'e-blood', 'e-guild'])
  })

  it('a failed create propagates and leaves the bank as it was', async () => {
    setIpcClient(fakeClient({ 'entity:create': failure }).client)
    await state().load()
    await expect(
      state().create({ kind: 'character', name: 'Mara', template: 'structured' })
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(state().ids).toHaveLength(5)
  })

  it('update replaces the row and re-sorts on a rename', async () => {
    const renamed: Entity = { ...mara, name: 'Zara', modified: '2026-09-10T00:00:00.000Z' }
    const { client, calls } = fakeClient({ 'entity:update': () => renamed })
    setIpcClient(client)
    await state().load()
    await state().update('e-mara', { name: 'Zara' })
    expect(calls.at(-1)).toEqual(['entity:update', { id: 'e-mara', name: 'Zara' }])
    expect(state().byId['e-mara']).toEqual(renamed)
    expect(state().ids.slice(0, 2)).toEqual(['e-aldous', 'e-mara'])
    const untouched = state().ids
    const same: Entity = { ...renamed, fields: { age: '30' } }
    setIpcClient(fakeClient({ 'entity:update': () => same }).client)
    await state().update('e-mara', { fields: { age: '30' } })
    expect(state().ids).toBe(untouched) // no rename, no re-sort
  })

  it('remove drops the row and clears a selection pointing at it', async () => {
    const { client, calls } = fakeClient({ 'entity:delete': () => null })
    setIpcClient(client)
    await state().load()
    state().select('e-mara')
    await state().remove('e-mara')
    expect(calls.at(-1)).toEqual(['entity:delete', { id: 'e-mara' }])
    expect(state().byId['e-mara']).toBeUndefined()
    expect(state().ids).not.toContain('e-mara')
    expect(state().selectedId).toBeNull()
  })

  it('remove keeps a selection of another entity', async () => {
    setIpcClient(fakeClient({ 'entity:delete': () => null }).client)
    await state().load()
    state().select('e-aldous')
    await state().remove('e-mara')
    expect(state().selectedId).toBe('e-aldous')
  })

  it('the view is per kind, defaults to cards, and resets on clear', () => {
    expect(state().view.character).toBe('cards')
    state().setView('character', 'list')
    expect(state().view).toEqual({ character: 'list', setting: 'cards', world: 'cards' })
    state().select('e-mara')
    state().clear()
    expect(state().view.character).toBe('cards')
    expect(state().selectedId).toBeNull()
  })
})
