import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Input, Output, Tag, TreeNode } from '@shared/ipc/contract'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { applyAgentEdit } from './agentApply'

/**
 * F-5.25 (agent.v7, the audit's fix 3): a bulk edit applies to every item it names through the
 * same store actions as one-at-a-time, logs one row per tag link under the turn's run, and its
 * one Undo takes them all back, newest first.
 */

let calls: [Channel, unknown][]
/** A move or sheet change of this id fails, as main would refuse it. */
let refuseId: string | null = null
const RUN = { source: 'chat', run: 'm-1' } as const

const storm: Tag = {
  id: 'storm',
  name: 'storm',
  category: 'tone',
  color: '#6b7280',
  parentId: null,
  usageCount: 0,
  trackMentions: true,
  aliases: [],
  created: '2026-10-10T09:00:00.000Z',
  modified: '2026-10-10T09:00:00.000Z'
}

const node = (id: string, parentId: string | null, kind: 'folder' | 'document'): TreeNode => ({
  id,
  parentId,
  sectionType: parentId === null ? 'manuscript' : null,
  kind,
  hierarchyLevel: parentId === null ? null : kind === 'folder' ? 'chapter' : 'scene',
  title: id,
  position: 0,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: '2026-10-10T09:00:00.000Z',
  modified: '2026-10-10T09:00:00.000Z'
})

function install(): void {
  calls = []
  refuseId = null
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'documentTag:add' || channel === 'documentTag:remove') {
        return storm as Output<C>
      }
      if (channel === 'entity:update') {
        const { id, kind } = input as Input<'entity:update'>
        if (id === refuseId) throw new Error('Refused')
        return {
          id,
          kind: kind ?? 'character',
          name: id,
          template: 'structured',
          fields: {},
          body: null,
          image: null,
          tagId: null,
          aliases: [],
          origin: 'author',
          status: 'canon',
          created: '2026-10-10T09:00:00.000Z',
          modified: '2026-10-10T09:00:00.000Z'
        } as Output<C>
      }
      if (channel === 'tree:move') {
        if ((input as Input<'tree:move'>).id === refuseId) throw new Error('Refused')
        // Main answers the node where it landed: right after `afterId`, or first.
        const { id, parentId, afterId } = input as Input<'tree:move'>
        const after = afterId == null ? -1 : (useTreeStore.getState().byId[afterId]?.position ?? -1)
        const moved = useTreeStore.getState().byId[id]
        const sameParentBefore = moved?.parentId === parentId && moved.position <= after
        return {
          ...node(id, parentId, 'document'),
          position: sameParentBefore ? after : after + 1
        } as Output<C>
      }
      if (channel === 'changes:record') {
        const { changes } = input as Input<'changes:record'>
        return changes.map((change, i): ChangeEntry => ({
          id: `c${calls.length}-${i}`,
          runId: 'chat:m-1',
          createdAt: '2026-10-10T10:00:00.000Z',
          nodeId: null,
          quote: null,
          kind: change.kind,
          entityId: null,
          label: change.label,
          status: 'applied',
          source: 'chat',
          undoable: true
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

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

describe('bulk agent edits (F-5.25)', () => {
  beforeEach(() => {
    resetChangesStore()
    resetEntityStore()
    resetTagStore()
    resetDocumentTagStore()
    useTreeStore.setState(
      buildIndex([
        node('ms', null, 'folder'),
        { ...node('c1', 'ms', 'folder'), position: 0 },
        { ...node('c2', 'ms', 'folder'), position: 1 },
        { ...node('s1', 'c1', 'document'), position: 0 },
        { ...node('s2', 'c2', 'document'), position: 0 },
        { ...node('s3', 'c2', 'document'), position: 1 }
      ])
    )
    useTagStore.getState().merge(storm)
    install()
  })
  afterEach(() => {
    resetChangesStore()
    resetDocumentTagStore()
    resetTagStore()
    useTreeStore.setState(buildIndex([]))
  })

  it('tags many documents, logs a row each in one call, and one Undo takes them all back', async () => {
    const undo = await applyAgentEdit(
      {
        kind: 'tagMany',
        nodes: [
          { nodeId: 's1', title: 'Scene 1' },
          { nodeId: 's2', title: 'Scene 2' }
        ],
        tag: 'storm',
        add: true
      },
      'p-1',
      RUN
    )
    expect(sent('documentTag:add')).toEqual([
      { nodeId: 's1', tagId: 'storm' },
      { nodeId: 's2', tagId: 'storm' }
    ])
    const recorded = sent('changes:record') as Input<'changes:record'>[]
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ source: 'chat', run: 'm-1' })
    expect(recorded[0]?.changes.map((c) => c.undo)).toEqual([
      { type: 'unlinkTag', nodeId: 's1', tagId: 'storm' },
      { type: 'unlinkTag', nodeId: 's2', tagId: 'storm' }
    ])
    expect(undo).not.toBeNull()
    await undo?.()
    // Newest first.
    expect((sent('changes:undo') as { id: string }[]).map((u) => u.id)).toHaveLength(2)
    const ids = (sent('changes:undo') as { id: string }[]).map((u) => u.id)
    expect(ids).toEqual([...ids].sort().reverse())
  })

  it('a recategorise that fails part-way takes back the sheets it changed, then reports', async () => {
    refuseId = 'tomas'
    await expect(
      applyAgentEdit(
        {
          kind: 'sheetPatch',
          sheets: [
            { entityId: 'mara', name: 'Mara', kind: 'character' },
            { entityId: 'tomas', name: 'Tomas', kind: 'character' }
          ],
          rename: null,
          to: 'world',
          toName: 'World'
        },
        'p-1',
        RUN
      )
    ).rejects.toThrow('Refused')
    // Mara moved and was logged; her change is undone through the log.
    expect(sent('entity:update')).toEqual([
      { id: 'mara', kind: 'world' },
      { id: 'tomas', kind: 'world' }
    ])
    expect(sent('changes:undo')).toHaveLength(1)
  })

  it('a move that fails part-way puts back what it moved, then reports', async () => {
    refuseId = 's3'
    await expect(
      applyAgentEdit(
        {
          kind: 'moveMany',
          nodes: [
            { nodeId: 's2', title: 's2' },
            { nodeId: 's3', title: 's3' }
          ],
          parentId: 'c1',
          parentTitle: 'c1'
        },
        'p-1',
        RUN
      )
    ).rejects.toThrow('Refused')
    expect(sent('tree:move')).toEqual([
      { id: 's2', parentId: 'c1', afterId: 's1' },
      { id: 's3', parentId: 'c1', afterId: 's2' },
      { id: 's2', parentId: 'c2', afterId: null }
    ])
  })

  it('moves many items to the end of a folder in order, and Undo moves them back newest first', async () => {
    const undo = await applyAgentEdit(
      {
        kind: 'moveMany',
        nodes: [
          { nodeId: 's2', title: 's2' },
          { nodeId: 's3', title: 's3' }
        ],
        parentId: 'c1',
        parentTitle: 'c1'
      },
      'p-1',
      RUN
    )
    expect(sent('tree:move')).toEqual([
      { id: 's2', parentId: 'c1', afterId: 's1' },
      { id: 's3', parentId: 'c1', afterId: 's2' }
    ])
    calls = []
    await undo?.()
    // s2 had left c2 when s3 moved, so s3 was first there; newest first, c2 is [s2, s3] again.
    expect(sent('tree:move')).toEqual([
      { id: 's3', parentId: 'c2', afterId: null },
      { id: 's2', parentId: 'c2', afterId: null }
    ])
  })
})
