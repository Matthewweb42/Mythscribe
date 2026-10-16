import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditFlowDetail, EditFlowIssue, EditFlowRun } from '@shared/editFlow'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetEditPassStore, useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetFocusStore } from '@renderer/features/focus/focusStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  EDIT_FLOW_NO_CHAPTER,
  EDIT_FLOW_NO_SCENE,
  EDIT_FLOW_PICK_ONE,
  notesUpdateTarget,
  openNotesUpdate,
  openNotesUpdateHere,
  resetEditFlowStore,
  specFor,
  useEditFlowStore
} from './editFlowStore'

function flowRun(over: Partial<EditFlowRun> = {}): EditFlowRun {
  return {
    id: 'run-1',
    spec: { categories: ['copy'], depth: 'quick', scope: { kind: 'scene', nodeId: 'sc-1' } },
    scopeTitle: 'Chapter 1 › Scene 1',
    automatic: false,
    status: 'running',
    done: 0,
    total: 1,
    model: 'deepseek-v4-flash',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    overview: null,
    noteEdits: [],
    createdAt: '2026-10-15T10:00:00.000Z',
    finishedAt: null,
    ...over
  }
}

function flowIssue(over: Partial<EditFlowIssue> = {}): EditFlowIssue {
  return {
    id: 'i1',
    passId: 'run-1',
    nodeId: 'sc-1',
    kind: 'change',
    position: 0,
    original: 'She teh sea.',
    replacement: 'She saw the sea.',
    rationale: 'Typo.',
    category: null,
    flagged: false,
    violation: null,
    status: 'pending',
    proposalId: 'prop-1',
    flowCategory: 'copy',
    textChanged: false,
    ...over
  }
}

let calls: { channel: string; input: unknown }[]
let detail: EditFlowDetail
let listeners: Map<string, (payload: never) => void>

function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push({ channel, input })
      switch (channel) {
        case 'editFlow:list':
          return [flowRun()] as Output<C>
        case 'editFlow:start':
          return { ok: true, run: flowRun({ id: 'run-2' }) } as Output<C>
        case 'editFlow:get':
          return detail as Output<C>
        case 'editFlow:noteUndone':
          return flowRun({
            id: 'run-2',
            noteEdits: detail.run.noteEdits.map((entry) => ({ ...entry, undone: true }))
          }) as Output<C>
        case 'notebook:restoreVersion':
          return null as Output<C>
        case 'editPass:changes':
          return [] as Output<C>
        case 'editFlow:autoSettings':
          return { on: false, dailyCap: 10 } as Output<C>
        case 'editFlow:setAutoSettings':
          return input as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }
  }
}

const sent = (channel: string): unknown[] =>
  calls.filter((call) => call.channel === channel).map((call) => call.input)

beforeEach(() => {
  calls = []
  listeners = new Map()
  detail = { run: flowRun({ id: 'run-2' }), issues: [flowIssue({ passId: 'run-2' })], titles: {} }
  resetEditFlowStore()
  resetEditPassStore()
  resetPendingSaves()
  resetLayoutStore()
  resetFocusStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  setIpcClient(client())
})

afterEach(() => {
  resetEditFlowStore()
  resetEditPassStore()
  resetLayoutStore()
  useTreeStore.getState().clear()
})

describe('specFor (the edit flow’s scope)', () => {
  const choices = { categories: ['copy' as const], depth: 'quick' as const, chapterId: null }

  it('this scene, its chapter, or the whole book; none without a pick or an open scene', () => {
    const open = { nodeId: 'sc-1', scene: true }
    expect(specFor({ ...choices, scope: 'scene' }, open)).toEqual({
      categories: ['copy'],
      depth: 'quick',
      scope: { kind: 'scene', nodeId: 'sc-1' }
    })
    expect(specFor({ ...choices, scope: 'chapter' }, open)).toMatchObject({
      scope: { kind: 'chapter', nodeId: 'ch-1' }
    })
    expect(specFor({ ...choices, scope: 'book' }, { nodeId: null, scene: false })).toMatchObject({
      scope: { kind: 'book', nodeId: null }
    })
    expect(specFor({ ...choices, scope: 'scene' }, { nodeId: null, scene: false })).toBe(
      EDIT_FLOW_NO_SCENE
    )
    expect(specFor({ ...choices, categories: [], scope: 'book' }, open)).toBe(EDIT_FLOW_PICK_ONE)
  })

  it('a chapter the chat named wins; a scene at the top of the manuscript has no chapter', () => {
    expect(
      specFor({ ...choices, scope: 'chapter', chapterId: 'ch-3' }, { nodeId: 'sc-1', scene: true })
    ).toMatchObject({ scope: { kind: 'chapter', nodeId: 'ch-3' } })
    const root = useTreeStore.getState().rootIds[0] ?? ''
    useTreeStore.setState({
      byId: {
        ...useTreeStore.getState().byId,
        loose: { ...useTreeStore.getState().byId['sc-1']!, id: 'loose', parentId: root }
      }
    })
    expect(specFor({ ...choices, scope: 'chapter' }, { nodeId: 'loose', scene: true })).toBe(
      EDIT_FLOW_NO_CHAPTER
    )
  })

  it('categories keep the flow’s order whatever the clicking order', () => {
    const store = useEditFlowStore.getState()
    store.toggleCategory('updateNotes')
    store.toggleCategory('developmental')
    store.toggleCategory('copy')
    expect(useEditFlowStore.getState().categories).toEqual(['developmental', 'updateNotes'])
  })
})

describe('useEditFlowStore', () => {
  it('opens pre-filled from the chat, and a scope change forgets the named chapter', () => {
    useEditFlowStore.getState().openFlow({ categories: ['continuity'], scope: 'chapter', chapterId: 'ch-3' })
    expect(useEditFlowStore.getState()).toMatchObject({
      open: true,
      categories: ['continuity'],
      scope: 'chapter',
      chapterId: 'ch-3'
    })
    useEditFlowStore.getState().setScope('scene')
    expect(useEditFlowStore.getState().chapterId).toBeNull()
  })

  it('a run starts, replaces the kept run of its scope, and shows its results', async () => {
    await useEditFlowStore.getState().load()
    expect(useEditFlowStore.getState().runs.map((run) => run.id)).toEqual(['run-1'])
    const spec = flowRun().spec
    expect(await useEditFlowStore.getState().start(spec)).toBe(true)
    expect(sent('editFlow:start')).toEqual([spec])
    expect(useEditFlowStore.getState().runs.map((run) => run.id)).toEqual(['run-2'])
    expect(useEditFlowStore.getState().shownId).toBe('run-2')
    expect(useEditFlowStore.getState().detail?.issues).toHaveLength(1)
  })

  it('a run’s event refreshes its results and the tracked changes the editor shows', async () => {
    await useEditFlowStore.getState().load()
    await useEditFlowStore.getState().show('run-2')
    useEditPassStore.setState({ changesByNode: { 'sc-1': [] } })
    const before = sent('editFlow:get').length
    listeners.get('editFlow:changed')?.(flowRun({ id: 'run-2', status: 'done' }) as never)
    await expect.poll(() => sent('editFlow:get').length).toBe(before + 1)
    expect(sent('editPass:changes')).toEqual([{ nodeId: 'sc-1' }])
    expect(useEditFlowStore.getState().runs.find((run) => run.id === 'run-2')?.status).toBe('done')
  })

  it('Undo of a note edit restores the page’s version and records it', async () => {
    detail = {
      run: flowRun({
        id: 'run-2',
        noteEdits: [
          {
            edit: {
              kind: 'notebook',
              pageId: 'pg-1',
              title: 'Mara',
              created: false,
              versionId: 'v-1',
              section: null,
              before: 'Eyes: grey.',
              after: 'Eyes: grey.\nFears the sea.'
            },
            undone: false
          }
        ]
      }),
      issues: [],
      titles: {}
    }
    await useEditFlowStore.getState().show('run-2')
    await useEditFlowStore.getState().undoNote(0)
    expect(sent('notebook:restoreVersion')).toEqual([{ versionId: 'v-1' }])
    expect(sent('editFlow:noteUndone')).toEqual([{ id: 'run-2', index: 0 }])
    expect(useEditFlowStore.getState().detail?.run.noteEdits[0]?.undone).toBe(true)
  })
})

describe('notes updates (notes redesign phase 3)', () => {
  it('the step opens the flow pre-filled: Update notes, its scope, Quick (Deep for the book)', () => {
    openNotesUpdate('chapter', 'ch-2')
    expect(useEditFlowStore.getState()).toMatchObject({
      open: true,
      shownId: null,
      categories: ['updateNotes'],
      scope: 'chapter',
      chapterId: 'ch-2',
      sceneId: null,
      depth: 'quick'
    })
    // The right column opens to show it.
    expect(useLayoutStore.getState().layout.assistant.open).toBe(true)
    const open = { nodeId: 'sc-1', scene: true }
    expect(specFor(useEditFlowStore.getState(), open)).toEqual({
      categories: ['updateNotes'],
      depth: 'quick',
      scope: { kind: 'chapter', nodeId: 'ch-2' }
    })
    // A scene from the tree's menu, not the one open.
    openNotesUpdate('scene', 'sc-4')
    expect(specFor(useEditFlowStore.getState(), open)).toMatchObject({
      scope: { kind: 'scene', nodeId: 'sc-4' }
    })
    useEditFlowStore.getState().setScope('scene')
    expect(useEditFlowStore.getState().sceneId).toBeNull()
    openNotesUpdate('book', null)
    expect(useEditFlowStore.getState()).toMatchObject({ scope: 'book', depth: 'deep' })
  })

  it('the Notes button and a chat request take the open scene’s chapter, else the book', () => {
    expect(notesUpdateTarget('here')).toEqual({ scope: 'book', nodeId: null })
    expect(notesUpdateTarget('chapter')).toBe(EDIT_FLOW_NO_SCENE)
    useTreeStore.setState({ selectedId: 'sc-2' })
    expect(notesUpdateTarget('here')).toEqual({ scope: 'chapter', nodeId: 'ch-2' })
    expect(notesUpdateTarget('scene')).toEqual({ scope: 'scene', nodeId: 'sc-2' })
    expect(notesUpdateTarget('book')).toEqual({ scope: 'book', nodeId: null })
    openNotesUpdateHere()
    expect(useEditFlowStore.getState()).toMatchObject({
      categories: ['updateNotes'],
      scope: 'chapter',
      chapterId: 'ch-2'
    })
  })

  it('a run of the author’s keeps the automatic run of the same scope', async () => {
    await useEditFlowStore.getState().load()
    const spec = flowRun().spec
    useEditFlowStore.setState({
      runs: [flowRun({ id: 'run-auto', automatic: true }), flowRun()]
    })
    await useEditFlowStore.getState().start(spec)
    expect(useEditFlowStore.getState().runs.map((run) => run.id)).toEqual(['run-2', 'run-auto'])
  })

  it('reads and writes the automatic update’s switch and cap', async () => {
    await useEditFlowStore.getState().loadAuto()
    expect(useEditFlowStore.getState().auto).toEqual({ on: false, dailyCap: 10 })
    await useEditFlowStore.getState().setAuto({ on: true, dailyCap: 4 })
    expect(sent('editFlow:setAutoSettings')).toEqual([{ on: true, dailyCap: 4 }])
    expect(useEditFlowStore.getState().auto).toEqual({ on: true, dailyCap: 4 })
  })
})
