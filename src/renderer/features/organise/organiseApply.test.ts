import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output, Tag } from '@shared/ipc/contract'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { applyOrganiseAction } from './organiseApply'

let calls: [Channel, unknown][]

const sheet: Entity = {
  id: 'ferry',
  kind: 'world',
  name: 'The Ferry',
  template: 'structured',
  fields: {},
  body: null,
  image: null,
  tagId: 'ferry-tag',
  aliases: [],
  origin: 'author',
  created: '2026-10-08T09:00:00.000Z',
  modified: '2026-10-08T09:00:00.000Z'
}
const ferryTag: Tag = {
  id: 'ferry-tag',
  name: 'the-ferry',
  category: 'worldBuilding',
  color: '#6b7280',
  parentId: null,
  usageCount: 0,
  trackMentions: true,
  aliases: [],
  created: '2026-10-08T09:00:00.000Z',
  modified: '2026-10-08T09:00:00.000Z'
}

function install(): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'entity:create') return sheet as Output<C>
      if (channel === 'entity:delete' || channel === 'tag:delete') return undefined as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const channels = (): Channel[] => calls.map(([channel]) => channel)

describe('applyOrganiseAction (F-9.10)', () => {
  beforeEach(() => {
    resetTagStore()
    resetEntityStore()
    useTreeStore.setState(buildIndex([]))
    install()
  })
  afterEach(() => {
    useTreeStore.setState(buildIndex([]))
  })

  it('undoing a new sheet also removes the #tag it made', async () => {
    const undo = await applyOrganiseAction(
      { kind: 'createSheet', category: 'world', name: 'The Ferry', fields: {}, aliases: [] },
      new Map(),
      'p1'
    )
    useTagStore.setState({ byId: { [ferryTag.id]: ferryTag } })
    await undo?.()
    expect(channels()).toEqual(['entity:create', 'entity:delete', 'tag:delete'])
  })

  it('keeps a tag that existed before the sheet', async () => {
    useTagStore.setState({ byId: { [ferryTag.id]: ferryTag } })
    const undo = await applyOrganiseAction(
      { kind: 'createSheet', category: 'world', name: 'The Ferry', fields: {}, aliases: [] },
      new Map(),
      'p1'
    )
    await undo?.()
    expect(channels()).toEqual(['entity:create', 'entity:delete'])
  })

  it('refuses to delete a folder that is no longer empty', async () => {
    useTreeStore.setState({ childrenOf: { harbour: ['scene-1'] } })
    await expect(
      applyOrganiseAction(
        {
          kind: 'binder',
          edit: { kind: 'delete', target: 'node', id: 'harbour', name: 'Harbour' }
        },
        new Map(),
        'p1'
      )
    ).rejects.toThrow('Harbour is no longer empty')
    expect(calls).toEqual([])
  })
})
