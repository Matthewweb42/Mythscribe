import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { EMPTY_DOC } from '@shared/tiptap'
import { resetChangesStore } from '@renderer/features/changes/changesStore'
import { resetNotesStore } from '@renderer/features/editor/notesStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { resetFactStore } from '@renderer/features/entities/factStore'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { resetLibraryStore } from '@renderer/features/library/libraryStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetTodoStore } from '@renderer/features/todo/todoStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { applyAgentEdit } from './agentApply'
import { resetIndexingStore } from './indexingStore'

/**
 * F-5.25 (agent.v8, the audit's fixes 5, 7, 8): the new edits apply through their owners' own
 * paths: statuses through the entity and fact stores (logged in Changes with `restoreStatus`),
 * To do items through the list's settle (Undo reopens), the notes through their write path, the
 * summaries through the index queue, and the Library through the sidebar.
 */

let calls: [Channel, unknown][]
let notes: unknown
let indexAllOk = true
const RUN = { source: 'chat', run: 'm-1' } as const
const NOTES = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pell lies.' }] }]
}

function install(): void {
  calls = []
  notes = NOTES
  indexAllOk = true
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'entity:update': {
          const { id, status } = input as Input<'entity:update'>
          return {
            id,
            kind: 'character',
            name: 'Mara',
            template: 'structured',
            fields: {},
            body: null,
            image: null,
            tagId: null,
            aliases: [],
            origin: 'author',
            status: status ?? 'canon',
            created: '2026-10-10T09:00:00.000Z',
            modified: '2026-10-10T09:00:00.000Z'
          } as Output<C>
        }
        case 'fact:setStatus': {
          const { id, status } = input as Input<'fact:setStatus'>
          return {
            id,
            entityId: 'mara',
            attribute: 'age',
            value: '19',
            objectEntityId: null,
            nodeId: null,
            quote: null,
            origin: 'author',
            status,
            hidden: false,
            createdAt: '2026-10-10T09:00:00.000Z',
            updatedAt: '2026-10-10T09:00:00.000Z'
          } as Output<C>
        }
        case 'changes:record': {
          const { changes } = input as Input<'changes:record'>
          return changes.map((change, i): ChangeEntry => ({
            id: `c${i}`,
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
        case 'todo:settle':
        case 'todo:reopen':
          return null as Output<C>
        case 'todo:list':
          return {
            items: [],
            counts: { undefined: 0, contradiction: 0, looseEnd: 0, gap: 0, total: 0 },
            check: null
          } as Output<C>
        case 'notes:get':
          return { id: (input as Input<'notes:get'>).id, notes } as Output<C>
        case 'notes:save':
          notes = (input as Input<'notes:save'>).notes
          return null as Output<C>
        case 'jobs:indexAll':
          return (
            indexAllOk
              ? {
                  ok: true,
                  queued: 2,
                  status: { waiting: 2, running: null, failed: 0, done: 0, paused: null }
                }
              : {
                  ok: false,
                  code: 'DISABLED',
                  message: 'Summaries are off.',
                  nextStep: 'Turn them on in Settings › AI.'
                }
          ) as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

const reset = (): void => {
  resetChangesStore()
  resetEntityStore()
  resetFactStore()
  resetTodoStore()
  resetNotesStore()
  resetIndexingStore()
  resetLibraryStore()
  resetLayoutStore()
  resetFocusStore()
}

describe('agent.v8 edits (F-5.25)', () => {
  beforeEach(() => {
    reset()
    install()
  })
  afterEach(reset)

  it('marks a sheet through the entity store, logged with restoreStatus', async () => {
    const undo = await applyAgentEdit(
      {
        kind: 'status',
        target: 'record',
        id: 'mara',
        name: 'Mara',
        label: '',
        status: 'idea',
        items: [{ id: 'mara', before: 'canon' }]
      },
      'p-1',
      RUN
    )
    expect(sent('entity:update')).toEqual([{ id: 'mara', status: 'idea' }])
    const recorded = sent('changes:record') as Input<'changes:record'>[]
    expect(recorded[0]?.changes).toEqual([
      {
        kind: 'record',
        label: 'Marked Mara idea',
        undo: { type: 'restoreStatus', entityId: 'mara', facts: [], before: 'canon', after: 'idea' }
      }
    ])
    expect(undo).not.toBeNull()
  })

  it('marks the statements of a field through the fact store, each one, logged as a fact row', async () => {
    await applyAgentEdit(
      {
        kind: 'status',
        target: 'facts',
        id: 'mara',
        name: 'Mara',
        label: 'Age',
        status: 'plan',
        items: [
          { id: 'f1', before: 'canon' },
          { id: 'f2', before: 'idea' }
        ]
      },
      'p-1',
      RUN
    )
    expect(sent('fact:setStatus')).toEqual([
      { id: 'f1', status: 'plan' },
      { id: 'f2', status: 'plan' }
    ])
    const recorded = sent('changes:record') as Input<'changes:record'>[]
    expect(recorded[0]?.changes[0]).toMatchObject({
      kind: 'fact',
      label: 'Marked Mara: Age plan',
      undo: { type: 'restoreStatus', facts: [{ id: 'f1' }, { id: 'f2' }], after: 'plan' }
    })
  })

  it('settles To do items through the list, and the Undo reopens them', async () => {
    const undo = await applyAgentEdit(
      {
        kind: 'todo',
        items: [
          { id: 'g1', subject: 'Mara' },
          { id: 'c:f1', subject: 'Age' }
        ],
        status: 'dismissed'
      },
      'p-1',
      RUN
    )
    expect(sent('todo:settle')).toEqual([
      { id: 'g1', status: 'dismissed' },
      { id: 'c:f1', status: 'dismissed' }
    ])
    await undo?.()
    // A contradiction stays settled in the consistency checker.
    expect(sent('todo:reopen')).toEqual([{ id: 'g1' }])
    expect(sent('todo:list')).toHaveLength(1)
  })

  it('empties a document’s notes, and the Undo puts them back while they are still empty', async () => {
    const undo = await applyAgentEdit(
      { kind: 'notesClear', nodeId: 's1', title: 'Scene 1' },
      'p-1',
      RUN
    )
    expect(notes).toEqual(EMPTY_DOC)
    await undo?.()
    expect(notes).toEqual(NOTES)
  })

  it('queues the stale summaries, and reports a refusal with its next step', async () => {
    expect(await applyAgentEdit({ kind: 'summaries' }, 'p-1', RUN)).toBeNull()
    expect(sent('jobs:indexAll')).toHaveLength(1)
    indexAllOk = false
    await expect(applyAgentEdit({ kind: 'summaries' }, 'p-1', RUN)).rejects.toThrow(
      'Summaries are off. Turn them on in Settings › AI.'
    )
  })

  it('opens the Library in the sidebar', async () => {
    expect(await applyAgentEdit({ kind: 'open', dialog: 'library' }, 'p-1', RUN)).toBeNull()
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('library')
  })
})
