import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  resetEntityDraftStore,
  useEntityDraftStore
} from '@renderer/features/entities/entityDraftStore'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { logAppliedChange, resetChangesStore, useChangesStore } from './changesStore'

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
  source: 'reading',
  undoable: true,
  ...over
})

let rows: ChangeEntry[]
let calls: [Channel, unknown][]
/** What the next `changes:undo` puts back (F-9.15). */
let restored: Output<'changes:undo'>['entities']
/** Whether `changes:record` refuses. */
let refuseRecord: boolean
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
          nodeIds: [],
          entities: restored,
          tags: []
        } as Output<C>
      }
      if (channel === 'changes:record') {
        if (refuseRecord) throw new Error('The change is not in the story bible')
        const { source, run, changes } = input as Input<'changes:record'>
        const logged = changes.map((change, i) =>
          entry(`rec-${rows.length + i}`, `${source}:${run}`, {
            kind: change.kind,
            label: change.label,
            nodeId: null,
            entityId: null,
            source,
            undoable: change.undo.type !== 'none'
          })
        )
        rows = [...logged, ...rows]
        return logged as Output<C>
      }
      if (channel === 'changes:undoRun') {
        const { runId } = input as Input<'changes:undoRun'>
        rows = rows.map((row) => (row.runId === runId ? { ...row, status: 'undone' } : row))
        return {
          entries: rows.filter((row) => row.runId === runId),
          removedEntityIds: ['e-aldous'],
          removedTagIds: ['t-gone'],
          entityIds: [],
          nodeIds: ['sc-1'],
          entities: [],
          tags: []
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
    resetPendingSaves()
    resetChangesStore()
    resetEntityStore()
    resetTagStore()
    resetEntityDraftStore()
    restored = []
    refuseRecord = false
    rows = [entry('c1', 'r2'), entry('c2', 'r2', { kind: 'record' }), entry('c3', 'r1')]
    install()
    await useEntityStore.getState().load()
  })
  afterEach(() => {
    resetChangesStore()
    resetEntityStore()
    resetTagStore()
    resetEntityDraftStore()
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

  it('logs a store change and answers the log’s undo as its own (F-9.15)', async () => {
    await useChangesStore.getState().load()
    let local = 0
    const undo = await logAppliedChange(
      { source: 'organise', run: 'org-1' },
      {
        kind: 'sheetEdit',
        label: 'Sheet “Mara”: 1 field',
        undo: {
          type: 'restoreSheet',
          entityId: 'e-mara',
          before: { fields: { role: '' } },
          after: { fields: { role: 'Captain' } }
        }
      },
      async () => {
        local += 1
      }
    )
    const logged = useChangesStore.getState().entries[0]
    expect(logged).toMatchObject({ runId: 'organise:org-1', source: 'organise', undoable: true })
    await undo?.()
    expect(local).toBe(0)
    expect(calls.at(-1)).toEqual(['changes:undo', { id: logged?.id }])
  })

  it('answers no undo for a merge, and the old undo when the log refuses (F-9.15)', async () => {
    const merge = await logAppliedChange(
      { source: 'organise', run: 'org-1' },
      {
        kind: 'merge',
        label: 'Merge tags',
        targetId: 't-1',
        undo: { type: 'none', reason: 'A merge cannot be undone.' }
      },
      async () => undefined
    )
    expect(merge).toBeNull()
    refuseRecord = true
    const fallback = async (): Promise<void> => undefined
    const undo = await logAppliedChange(
      { source: 'chat', run: 'm-1' },
      {
        kind: 'tagLink',
        label: 'Tag Scene 1 #mara',
        undo: { type: 'unlinkTag', nodeId: 'sc-1', tagId: 't-1' }
      },
      fallback
    )
    expect(undo).toBe(fallback)
  })

  it('saves an open sheet page before an undo and shows the sheet as put back (F-9.15)', async () => {
    const mara = useEntityStore.getState().byId['e-mara']
    if (mara === undefined) throw new Error('fixture')
    useEntityDraftStore.getState().open(mara)
    restored = [{ ...mara, fields: { ...mara.fields, role: 'Put back' } }]
    await useChangesStore.getState().load()
    await useChangesStore.getState().undo('c1')
    expect(useEntityStore.getState().byId['e-mara']?.fields.role).toBe('Put back')
    expect(useEntityDraftStore.getState().draft?.fields.role).toBe('Put back')
    expect(useEntityDraftStore.getState().status).toBe('idle')
  })
})
