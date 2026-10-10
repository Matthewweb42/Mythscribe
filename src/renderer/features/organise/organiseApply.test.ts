import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Entity, Input, Output, Tag } from '@shared/ipc/contract'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { applyOrganiseAction } from './organiseApply'
import { NO_SHEET_SYNC } from '@shared/sheetSync'

let calls: [Channel, unknown][]
/** Whether main logs `changes:record` (F-9.15); off, the log refuses and the old undo stays. */
let logging: boolean
const RUN = { source: 'organise', run: 'org-1' } as const

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
  status: 'canon',
  extraFields: [],
  sync: NO_SHEET_SYNC,
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
      if (channel === 'tag:merge') {
        return { target: ferryTag, removedIds: ['t-old'], aliases: {} } as Output<C>
      }
      if (channel === 'changes:record' && logging) {
        const { changes } = input as Input<'changes:record'>
        return changes.map((change, i): ChangeEntry => ({
          id: `c${i}`,
          runId: 'organise:org-1',
          createdAt: '2026-10-09T10:00:00.000Z',
          nodeId: null,
          quote: null,
          kind: change.kind,
          entityId: null,
          label: change.label,
          status: 'applied',
          source: 'organise',
          undoable: change.undo.type !== 'none'
        })) as Output<C>
      }
      if (channel === 'changes:undo') {
        return {
          entries: [],
          removedEntityIds: [],
          removedTagIds: [],
          entityIds: [],
          nodeIds: [],
          entities: [],
          tags: []
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const channels = (): Channel[] => calls.map(([channel]) => channel)

describe('applyOrganiseAction (F-9.10)', () => {
  beforeEach(() => {
    logging = false
    resetChangesStore()
    resetCategoryStore()
    resetTagStore()
    resetEntityStore()
    useTreeStore.setState(buildIndex([]))
    install()
  })
  afterEach(() => {
    resetChangesStore()
    useTreeStore.setState(buildIndex([]))
  })

  it('undoing a new sheet also removes the #tag it made', async () => {
    const undo = await applyOrganiseAction(
      { kind: 'createSheet', category: 'world', name: 'The Ferry', fields: {}, aliases: [] },
      new Map(),
      'p1',
      RUN
    )
    useTagStore.setState({ byId: { [ferryTag.id]: ferryTag } })
    await undo?.()
    // The log refused the entry (this mock), so the sheet's own undo stayed.
    expect(channels()).toEqual(['entity:create', 'changes:record', 'entity:delete', 'tag:delete'])
  })

  it('logs a new sheet in Changes and undoes it there (F-9.15)', async () => {
    logging = true
    const undo = await applyOrganiseAction(
      { kind: 'createSheet', category: 'world', name: 'The Ferry', fields: {}, aliases: [] },
      new Map(),
      'p1',
      RUN
    )
    const recorded = calls.find(([channel]) => channel === 'changes:record')?.[1]
    expect(recorded).toMatchObject({
      source: 'organise',
      run: 'org-1',
      changes: [
        {
          kind: 'record',
          undo: {
            type: 'deleteSheet',
            entityId: 'ferry',
            tagId: 'ferry-tag',
            modified: sheet.modified
          }
        }
      ]
    })
    await undo?.()
    expect(channels()).toEqual(['entity:create', 'changes:record', 'changes:undo'])
  })

  it('logs a merge with no undo, keeping Organise’s rule (F-9.15)', async () => {
    logging = true
    const undo = await applyOrganiseAction(
      {
        kind: 'mergeTags',
        target: { id: 'ferry-tag', name: 'the-ferry' },
        sources: [{ id: 't-old', name: 'ferry' }]
      },
      new Map(),
      'p1',
      RUN
    )
    expect(undo).toBeNull()
    const recorded = calls.find(([channel]) => channel === 'changes:record')?.[1]
    expect(recorded).toMatchObject({
      changes: [{ kind: 'merge', targetId: 'ferry-tag', undo: { type: 'none' } }]
    })
  })

  it('keeps a tag that existed before the sheet', async () => {
    useTagStore.setState({ byId: { [ferryTag.id]: ferryTag } })
    const undo = await applyOrganiseAction(
      { kind: 'createSheet', category: 'world', name: 'The Ferry', fields: {}, aliases: [] },
      new Map(),
      'p1',
      RUN
    )
    await undo?.()
    expect(channels()).toEqual(['entity:create', 'changes:record', 'entity:delete'])
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
        'p1',
        RUN
      )
    ).rejects.toThrow('Harbour is no longer empty')
    expect(calls).toEqual([])
  })
})
