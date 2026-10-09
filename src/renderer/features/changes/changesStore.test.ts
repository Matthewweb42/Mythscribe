import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetChangesStore, useChangesStore } from './changesStore'

const entry = (id: string, runId: string, over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  id,
  runId,
  createdAt: '2026-10-08T10:00:00.000Z',
  nodeId: 'sc-1',
  quote: null,
  kind: 'fact',
  entityId: 'e-mara',
  label: `change ${id}`,
  status: 'applied',
  ...over
})

let rows: ChangeEntry[]
let calls: [Channel, unknown][]
let listener: (() => void) | null

function install(): void {
  calls = []
  listener = null
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'changes:list') {
        const { before, limit = 100 } = input as Input<'changes:list'>
        const from = before === undefined ? 0 : rows.findIndex((row) => row.id === before) + 1
        return {
          entries: rows.slice(from, from + limit),
          more: rows.length > from + limit
        } as Output<C>
      }
      if (channel === 'changes:undo') {
        const { id } = input as Input<'changes:undo'>
        rows = rows.map((row) => (row.id === id ? { ...row, status: 'undone' } : row))
        return {
          entries: rows.filter((row) => row.id === id),
          removedEntityIds: [],
          removedTagIds: [],
          entityIds: ['e-mara'],
          nodeIds: []
        } as Output<C>
      }
      if (channel === 'changes:undoRun') {
        const { runId } = input as Input<'changes:undoRun'>
        rows = rows.map((row) => (row.runId === runId ? { ...row, status: 'undone' } : row))
        return {
          entries: rows.filter((row) => row.runId === runId),
          removedEntityIds: ['e-aldous'],
          removedTagIds: ['t-gone'],
          entityIds: [],
          nodeIds: ['sc-1']
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: (channel, fn) => {
      if (channel !== 'changes:changed') throw new Error(`unexpected subscription ${channel}`)
      listener = () => (fn as (payload: Record<string, never>) => void)({})
      return () => {
        listener = null
      }
    }
  }
  setIpcClient(client)
}

describe('changesStore (F-9.13)', () => {
  beforeEach(async () => {
    resetChangesStore()
    resetEntityStore()
    resetTagStore()
    rows = [entry('c1', 'r2'), entry('c2', 'r2', { kind: 'record' }), entry('c3', 'r1')]
    install()
    await useEntityStore.getState().load()
  })
  afterEach(() => {
    resetChangesStore()
    resetEntityStore()
    resetTagStore()
  })

  it('loads the newest page, then older ones', async () => {
    await useChangesStore.getState().load()
    expect(useChangesStore.getState().entries.map((row) => row.id)).toEqual(['c1', 'c2', 'c3'])
    expect(useChangesStore.getState().more).toBe(false)
    expect(calls.at(-1)).toEqual(['changes:list', { limit: 100 }])
  })

  it('marks one change undone', async () => {
    await useChangesStore.getState().load()
    await useChangesStore.getState().undo('c1')
    expect(useChangesStore.getState().entries.map((row) => row.status)).toEqual([
      'undone',
      'applied',
      'applied'
    ])
    expect(useChangesStore.getState().pending).toEqual([])
  })

  it('undoes a run and drops the sheets and tags main deleted', async () => {
    useTagStore.setState({
      byId: {
        't-gone': {
          id: 't-gone',
          name: 'gone',
          category: 'tone',
          color: '#112233',
          parentId: null,
          usageCount: 0,
          trackMentions: true,
          aliases: [],
          created: '2026-10-08T10:00:00.000Z',
          modified: '2026-10-08T10:00:00.000Z'
        }
      },
      ids: ['t-gone']
    })
    await useChangesStore.getState().load()
    await useChangesStore.getState().undoRun('r2')
    expect(useChangesStore.getState().entries.map((row) => row.status)).toEqual([
      'undone',
      'undone',
      'applied'
    ])
    expect(useEntityStore.getState().byId['e-aldous']).toBeUndefined()
    expect(useTagStore.getState().ids).toEqual([])
  })

  it('reloads when main says the log moved, and drops answers after a clear', async () => {
    useChangesStore.getState().subscribe()
    rows = [entry('c9', 'r9'), ...rows]
    listener?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useChangesStore.getState().entries[0]?.id).toBe('c9')
    const pending = useChangesStore.getState().load()
    useChangesStore.getState().clear()
    await pending
    expect(useChangesStore.getState().entries).toEqual([])
  })
})
