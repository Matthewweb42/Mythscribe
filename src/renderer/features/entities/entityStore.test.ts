import { beforeEach, describe, expect, it } from 'vitest'
import type { EntityImportPlan } from '@shared/entityExchange'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
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

  it('subscribe merges an entity main created elsewhere, once, with no IPC call (F-5.16)', async () => {
    const listeners: ((entity: Entity) => void)[] = []
    const { client, calls } = fakeClient()
    client.on = (channel, listener) => {
      if (channel !== 'entity:changed') throw new Error(`unexpected subscription ${channel}`)
      listeners.push(listener as (entity: Entity) => void)
      return () => {
        listeners.splice(listeners.indexOf(listener as (entity: Entity) => void), 1)
      }
    }
    setIpcClient(client)
    state().subscribe()
    state().subscribe()
    expect(listeners).toHaveLength(1)
    await state().load()

    const logged: Entity = {
      ...mara,
      id: 'e-bram',
      name: 'Bram',
      template: 'blank',
      fields: {},
      origin: 'ai'
    }
    listeners[0]?.(logged)
    expect(state().ids).toEqual(['e-aldous', 'e-bram', 'e-mara', 'e-forest', 'e-blood', 'e-guild'])
    expect(state().byId['e-bram']?.origin).toBe('ai')
    // The same row again (main emits to every window) changes nothing but the row itself.
    const before = state().ids
    listeners[0]?.(logged)
    expect(state().ids).toBe(before)
    expect(calls).toEqual([['entity:list', undefined]])

    resetEntityStore()
    expect(listeners).toHaveLength(0)
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

  it('clear drops the selection', () => {
    state().select('e-mara')
    state().clear()
    expect(state().selectedId).toBeNull()
  })

  it('startCreate names the kind the dialog is open for; cancelCreate and clear close it (F-9.3)', () => {
    expect(state().creating).toBeNull()
    state().startCreate('world')
    expect(state().creating).toBe('world')
    state().startCreate('character')
    expect(state().creating).toBe('character')
    state().cancelCreate()
    expect(state().creating).toBeNull()
    state().startCreate('setting')
    state().clear()
    expect(state().creating).toBeNull()
  })

  it('setImage merges the returned row, and a cancelled dialog changes nothing (F-9.3)', async () => {
    const withImage: Entity = { ...mara, image: 'mara.0a1b2c3d.png' }
    const { client, calls } = fakeClient({ 'entity:setImage': () => withImage })
    setIpcClient(client)
    await state().load()
    const ids = state().ids
    await expect(state().setImage('e-mara')).resolves.toEqual(withImage)
    expect(calls.at(-1)).toEqual(['entity:setImage', { id: 'e-mara' }])
    expect(state().byId['e-mara']?.image).toBe('mara.0a1b2c3d.png')
    expect(state().ids).toBe(ids) // the name did not change, so the order is untouched

    setIpcClient(fakeClient({ 'entity:setImage': () => null }).client)
    await expect(state().setImage('e-mara')).resolves.toBeNull()
    expect(state().byId['e-mara']?.image).toBe('mara.0a1b2c3d.png')
  })

  it('removeImage merges the row with no image (F-9.3)', async () => {
    const { client, calls } = fakeClient({
      'entity:removeImage': () => ({ ...mara, image: null })
    })
    setIpcClient(client)
    await state().load()
    useEntityStore.setState({ byId: { ...state().byId, 'e-mara': { ...mara, image: 'a.png' } } })
    await state().removeImage('e-mara')
    expect(calls.at(-1)).toEqual(['entity:removeImage', { id: 'e-mara' }])
    expect(state().byId['e-mara']?.image).toBeNull()
  })

  it('a failed image request propagates and leaves the entity as it was (F-9.3)', async () => {
    setIpcClient(fakeClient({ 'entity:setImage': failure }).client)
    await state().load()
    await expect(state().setImage('e-mara')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(state().byId['e-mara']).toEqual(mara)
  })

  it('linkTag merges the entity here and the tag into the bank (F-9.4)', async () => {
    const tag = tagFixture[1]!
    const linked: Entity = { ...mara, tagId: tag.id }
    const { client, calls } = fakeClient({
      'entity:linkTag': () => ({ entity: linked, tag })
    })
    setIpcClient(client)
    resetTagStore()
    await state().load()
    const ids = state().ids
    await expect(state().linkTag('e-mara')).resolves.toEqual(linked)
    expect(calls.at(-1)).toEqual(['entity:linkTag', { id: 'e-mara' }])
    expect(state().byId['e-mara']?.tagId).toBe('t-mara')
    expect(state().ids).toBe(ids) // the name did not change, so the order is untouched
    expect(useTagStore.getState().byId['t-mara']).toEqual(tag)
  })

  it('a refused linkTag propagates and leaves both stores as they were (F-9.4)', async () => {
    setIpcClient(fakeClient({ 'entity:linkTag': failure }).client)
    resetTagStore()
    await state().load()
    await expect(state().linkTag('e-mara')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(state().byId['e-mara']).toEqual(mara)
    expect(useTagStore.getState().ids).toEqual([])
  })

  describe('export and import (F-9.5)', () => {
    const plan = (over: Partial<EntityImportPlan> = {}): EntityImportPlan => ({
      source: { name: 'library.json', format: 'json' },
      duplicates: 0,
      items: [
        {
          id: 'r1',
          record: {
            kind: 'character',
            name: 'Ilse',
            template: 'structured',
            fields: { age: '30' },
            body: null
          },
          existingId: null,
          action: 'add'
        },
        {
          id: 'r2',
          record: {
            kind: 'character',
            name: 'Mara',
            template: 'structured',
            fields: { background: 'Born at sea.' },
            body: null
          },
          existingId: 'e-mara',
          action: 'merge'
        }
      ],
      ...over
    })

    it('exportKind asks main and answers where the file went', async () => {
      const written = { path: '/tmp/Book-characters.json', count: 2 }
      const { client, calls } = fakeClient({ 'entity:export': () => written })
      setIpcClient(client)
      await expect(state().exportKind('character', 'json')).resolves.toEqual(written)
      expect(calls.at(-1)).toEqual(['entity:export', { kind: 'character', format: 'json' }])
      setIpcClient(fakeClient({ 'entity:export': () => null }).client)
      await expect(state().exportKind('world', 'csv')).resolves.toBeNull()
    })

    it('openImport holds the plan; a cancelled dialog leaves none', async () => {
      const { client, calls } = fakeClient({ 'entity:importOpen': () => plan() })
      setIpcClient(client)
      await state().load()
      await expect(state().openImport('character')).resolves.toEqual(plan())
      expect(calls.at(-1)).toEqual(['entity:importOpen', { kind: 'character' }])
      expect(state().importPlan).toEqual(plan())
      expect(state().importKind).toBe('character')
      state().cancelImport()
      expect(state().importPlan).toBeNull()
      expect(state().importKind).toBeNull()

      setIpcClient(fakeClient({ 'entity:importOpen': () => null }).client)
      await expect(state().openImport('character')).resolves.toBeNull()
      expect(state().importPlan).toBeNull()
    })

    it('setImportAction changes one row and leaves the others identical', async () => {
      setIpcClient(fakeClient({ 'entity:importOpen': () => plan() }).client)
      await state().openImport('character')
      const before = state().importPlan
      state().setImportAction('r2', 'replace')
      expect(state().importPlan?.items.map((item) => item.action)).toEqual(['add', 'replace'])
      expect(state().importPlan?.items[0]).toBe(before?.items[0])
      const unchanged = state().importPlan
      state().setImportAction('r2', 'replace')
      state().setImportAction('nope', 'skip')
      expect(state().importPlan).toBe(unchanged)
    })

    it('commitImport merges what came back, clears the plan, and answers the counts', async () => {
      const ilse: Entity = { ...mara, id: 'e-ilse', name: 'Ilse', fields: { age: '30' } }
      const merged: Entity = { ...mara, fields: { ...mara.fields, background: 'Born at sea.' } }
      const { client, calls } = fakeClient({
        'entity:importOpen': () => plan(),
        'entity:importCommit': () => ({
          entities: [ilse, merged],
          added: 1,
          merged: 1,
          replaced: 0
        })
      })
      setIpcClient(client)
      await state().load()
      await state().openImport('character')
      await expect(state().commitImport()).resolves.toEqual({ added: 1, merged: 1, replaced: 0 })
      expect(calls.at(-1)).toEqual(['entity:importCommit', { items: plan().items }])
      expect(state().ids).toEqual([
        'e-aldous',
        'e-ilse',
        'e-mara',
        'e-forest',
        'e-blood',
        'e-guild'
      ])
      expect(state().byId['e-mara']?.fields.background).toBe('Born at sea.')
      expect(state().importPlan).toBeNull()
    })

    it('a failed commit propagates and keeps the plan open', async () => {
      setIpcClient(
        fakeClient({ 'entity:importOpen': () => plan(), 'entity:importCommit': failure }).client
      )
      await state().load()
      await state().openImport('character')
      await expect(state().commitImport()).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
      expect(state().importPlan).not.toBeNull()
      expect(state().ids).toHaveLength(5)
    })

    it('clear drops the plan under review', async () => {
      setIpcClient(fakeClient({ 'entity:importOpen': () => plan() }).client)
      await state().openImport('character')
      state().clear()
      expect(state().importPlan).toBeNull()
      expect(state().importKind).toBeNull()
    })
  })
})
