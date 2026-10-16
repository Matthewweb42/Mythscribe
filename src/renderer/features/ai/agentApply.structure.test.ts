import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import type { Channel, Input, Output, TreeNode } from '@shared/ipc/contract'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetNotebookPageStore } from '@renderer/features/notebook/notebookPageStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { AgentEditError } from '@renderer/features/editor/agentEditing'
import { applyAgentEdit, undoNotebookEdit } from './agentApply'

/**
 * Notes structure part C (scribe.v5, 2026-10-16): Ms Scribe's structure changes applied and
 * undone through the chat agent's paths. A new chapter with its scenes is the old agent's create
 * plus its bulk move, undone in one; her Notes changes are already made in main and only undone
 * here (folder deleted, items moved back newest first, old name back); a Notes deletion runs on
 * the author's Delete and its Undo restores it.
 */

let calls: [Channel, unknown][]
const RUN = { source: 'chat', run: 'm-1' } as const

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
  created: '2026-10-16T09:00:00.000Z',
  modified: '2026-10-16T09:00:00.000Z'
})

function install(): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'tree:create') {
        const { parentId } = input as Input<'tree:create'>
        return { ...node('new-chapter', parentId, 'folder'), position: 2 } as Output<C>
      }
      if (channel === 'tree:move') {
        const { id, parentId } = input as Input<'tree:move'>
        return node(id, parentId, 'document') as Output<C>
      }
      if (channel === 'tree:delete') return null as Output<C>
      if (
        channel === 'notebook:delete' ||
        channel === 'notebook:move' ||
        channel === 'notebook:update'
      ) {
        return null as Output<C>
      }
      if (channel === 'notebook:restore') {
        return {
          id: (input as Input<'notebook:restore'>).id,
          parentId: null,
          kind: 'page',
          title: 'Tash',
          position: 0,
          modified: '2026-10-16T09:00:00.000Z'
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

describe('Ms Scribe’s structure changes in the chat (scribe.v5)', () => {
  beforeEach(() => {
    resetChangesStore()
    resetNotebookPageStore()
    useTreeStore.setState(
      buildIndex([
        node('ms', null, 'folder'),
        { ...node('c1', 'ms', 'folder'), position: 0 },
        { ...node('s1', 'c1', 'document'), position: 0 },
        { ...node('s2', 'c1', 'document'), position: 1 }
      ])
    )
    install()
  })
  afterEach(() => {
    resetChangesStore()
    resetNotebookPageStore()
    useTreeStore.setState(buildIndex([]))
  })

  it('a new chapter takes its scenes in, and its Undo moves them back, then removes it', async () => {
    const undo = await applyAgentEdit(
      {
        kind: 'create',
        level: 'chapter',
        parentId: 'ms',
        parentTitle: 'Manuscript',
        afterId: null,
        title: 'The Fall',
        text: '',
        moveIn: [
          { nodeId: 's1', title: 's1' },
          { nodeId: 's2', title: 's2' }
        ]
      },
      'p-1',
      RUN
    )
    expect(sent('tree:create')).toEqual([
      { parentId: 'ms', kind: 'folder', hierarchyLevel: 'chapter', title: 'The Fall' }
    ])
    expect(sent('tree:move')).toEqual([
      { id: 's1', parentId: 'new-chapter', afterId: null },
      { id: 's2', parentId: 'new-chapter', afterId: 's1' }
    ])
    calls = []
    await undo?.()
    expect(calls.map(([channel]) => channel)).toEqual(['tree:move', 'tree:move', 'tree:delete'])
    expect(sent('tree:move')).toEqual([
      { id: 's2', parentId: 'c1', afterId: null },
      { id: 's1', parentId: 'c1', afterId: null }
    ])
    expect(sent('tree:delete')).toEqual([{ id: 'new-chapter' }])
  })

  it('a Notes deletion runs on Delete, and its Undo restores it', async () => {
    const edit: AgentEdit = {
      kind: 'notebookDelete',
      id: 'pg-tash',
      title: 'Tash',
      folder: false,
      pages: 0
    }
    const undo = await applyAgentEdit(edit, 'p-1', RUN)
    expect(sent('notebook:delete')).toEqual([{ id: 'pg-tash' }])
    await undo?.()
    expect(sent('notebook:restore')).toEqual([{ id: 'pg-tash' }])
  })

  it('her Notes changes are already made; their stored Undo takes each back', async () => {
    await expect(
      applyAgentEdit(
        { kind: 'notebookFolder', folderId: 'f-1', title: 'Characters', parent: '' },
        'p-1',
        RUN
      )
    ).rejects.toBeInstanceOf(AgentEditError)
    await undoNotebookEdit({
      kind: 'notebookFolder',
      folderId: 'f-1',
      title: 'Characters',
      parent: ''
    })
    await undoNotebookEdit({
      kind: 'notebookMove',
      items: [
        { id: 'pg-tash', title: 'Tash', folder: false, fromParentId: null, fromPosition: 0 },
        { id: 'pg-mara', title: 'Mara', folder: false, fromParentId: 'f-2', fromPosition: 3.5 }
      ],
      parentId: 'f-1',
      parentTitle: 'Characters'
    })
    await undoNotebookEdit({
      kind: 'notebookRename',
      id: 'pg-tash',
      folder: false,
      title: 'Tash',
      after: 'Tash Venn'
    })
    expect(calls).toEqual([
      ['notebook:delete', { id: 'f-1' }],
      ['notebook:move', { id: 'pg-mara', parentId: 'f-2', position: 3.5 }],
      ['notebook:move', { id: 'pg-tash', parentId: null, position: 0 }],
      ['notebook:update', { id: 'pg-tash', title: 'Tash' }]
    ])
  })
})
