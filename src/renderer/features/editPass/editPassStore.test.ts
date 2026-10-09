import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditChange, EditPassSummary } from '@shared/editPass'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { TRACKED_DEL_CLASS, TRACKED_INS_CLASS } from '@renderer/features/editor/trackedChanges'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { applyChangesToDoc } from './applyChange'
import {
  registerTrackedEditor,
  resetEditPassStore,
  runningPass,
  useEditPassStore
} from './editPassStore'
import { resetEditPassViewStore, useEditPassViewStore } from './editPassViewStore'

const TEXT = 'The harbour bell rang very very slowly over the water.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function pass(over: Partial<EditPassSummary> = {}): EditPassSummary {
  return {
    id: 'p1',
    type: 'proofread',
    instruction: null,
    status: 'running',
    nodeIds: ['sc-1'],
    doneNodeIds: [],
    currentNodeId: 'sc-1',
    model: 'gpt-5.4-mini',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    createdAt: '2026-10-06T10:00:00.000Z',
    finishedAt: null,
    ...over
  }
}

function change(over: Partial<EditChange> = {}): EditChange {
  return {
    id: 'c1',
    passId: 'p1',
    nodeId: 'sc-1',
    kind: 'change',
    position: 0,
    original: 'rang very very slowly',
    replacement: 'rang slowly',
    rationale: 'Cut the doubled word.',
    category: null,
    flagged: false,
    violation: null,
    status: 'pending',
    proposalId: 'prop-1',
    ...over
  }
}

let passes: EditPassSummary[]
let changes: EditChange[]
let settles: Input<'editPass:settle'>[]
let saves: Input<'document:save'>[]
let starts: Input<'editPass:start'>[]
let stored: TiptapNodeT
let changed: ((payload: EventPayload<'editPass:changed'>) => void) | null
let editor: Editor | null

function fakeClient(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      switch (channel) {
        case 'editPass:list':
          return passes as Output<C>
        case 'editPass:presets':
          return [] as Output<C>
        case 'editPass:changes':
          return changes.filter(
            (c) => c.nodeId === (input as Input<'editPass:changes'>).nodeId
          ) as Output<C>
        case 'editPass:get':
          return { pass: passes[0] ?? pass(), changes, titles: { 'sc-1': 'Scene 1' } } as Output<C>
        case 'editPass:start': {
          starts.push(input as Input<'editPass:start'>)
          return { ok: true, pass: pass() } as Output<C>
        }
        case 'editPass:settle': {
          const asked = input as Input<'editPass:settle'>
          settles.push(asked)
          return changes
            .filter((c) => asked.ids.includes(c.id))
            .map((c) => ({ ...c, status: asked.status })) as Output<C>
        }
        case 'document:get':
          return { id: 'sc-1', content: stored } as Output<C>
        case 'document:save': {
          saves.push(input as Input<'document:save'>)
          return { wordCount: 3, modified: '2026-10-06' } as Output<C>
        }
        case 'recovery:stash':
        case 'recovery:clear':
          return null as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
      if (event === 'editPass:changed') {
        changed = listener as (payload: EventPayload<'editPass:changed'>) => void
      }
      return () => {
        if (event === 'editPass:changed') changed = null
      }
    }
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const store = () => useEditPassStore.getState()

function mount(text = TEXT): Editor {
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: doc(text)
  })
  return editor
}

beforeEach(() => {
  resetEditPassStore()
  resetEditPassViewStore()
  resetDocumentStore()
  resetEntityStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  passes = []
  changes = []
  settles = []
  saves = []
  starts = []
  stored = doc(TEXT)
  changed = null
  editor = null
  setIpcClient(fakeClient())
})

afterEach(() => {
  resetEditPassStore()
  resetEditPassViewStore()
  resetDocumentStore()
  if (editor && !editor.isDestroyed) editor.destroy()
})

describe('editPassStore (F-14.15)', () => {
  it('loads the passes, starts one, and opens its report when main says it finished', async () => {
    await store().load()
    expect(store().loaded).toBe(true)
    expect(await store().start({ type: 'proofread', instruction: null, nodeIds: ['sc-1'] })).toBe(
      true
    )
    expect(starts).toEqual([{ type: 'proofread', instruction: null, nodeIds: ['sc-1'] }])
    expect(runningPass(store())?.id).toBe('p1')

    passes = [pass({ status: 'done', doneNodeIds: ['sc-1'], currentNodeId: null })]
    changes = [change()]
    changed?.(passes[0]!)
    await flush()
    await flush()
    expect(runningPass(store())).toBeNull()
    expect(useEditPassViewStore.getState().view).toEqual({ kind: 'report', passId: 'p1' })
    expect(store().detail?.changes).toHaveLength(1)
    expect(useDialogStore.getState().toasts.at(-1)?.message).toBe(
      'Proofread finished. The report is open.'
    )
  })

  it('accepts a change in the mounted editor, AI-origin marked, and settles it', async () => {
    changes = [change()]
    const live = mount()
    registerTrackedEditor('sc-1', live)
    await store().loadChanges('sc-1')
    await store().accept(store().changesByNode['sc-1'] ?? [])
    expect(live.state.doc.textContent).toBe('The harbour bell rang slowly over the water.')
    const marked: string[] = []
    live.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === AI_ORIGIN_MARK)) {
        marked.push(node.text ?? '')
      }
    })
    expect(marked).toEqual(['rang slowly'])
    expect(settles).toEqual([{ ids: ['c1'], status: 'accepted' }])
    expect(store().changesByNode['sc-1']).toEqual([])
  })

  it('settles a change whose passage is gone as stale, and warns', async () => {
    changes = [change({ original: 'not in the scene any more' })]
    registerTrackedEditor('sc-1', mount())
    await store().loadChanges('sc-1')
    await store().accept(changes)
    expect(settles).toEqual([{ ids: ['c1'], status: 'stale' }])
    expect(useDialogStore.getState().toasts.at(-1)?.kind).toBe('warning')
  })

  it('accepts from the report with the scene closed, through the document store', async () => {
    changes = [change()]
    await store().accept(changes)
    await flush()
    expect(saves.at(-1)?.id).toBe('sc-1')
    expect(JSON.stringify(saves.at(-1)?.content)).toContain('rang slowly')
    expect(settles).toEqual([{ ids: ['c1'], status: 'accepted' }])
  })

  it('never touches a scene still in the running pass', async () => {
    passes = [pass()]
    await store().load()
    changes = [change()]
    await store().accept(changes)
    expect(saves).toEqual([])
    expect(settles).toEqual([])
  })

  it('rejects changes and dismisses notes without touching the text', async () => {
    changes = [change(), change({ id: 'n1', kind: 'note', replacement: null })]
    await store().reject(changes)
    expect(settles).toEqual([{ ids: ['c1', 'n1'], status: 'rejected' }])
  })
})

describe('applyChangesToDoc (F-14.15)', () => {
  it('applies in order, finds each passage again, and reports the gone ones', () => {
    const result = applyChangesToDoc(doc(TEXT), [
      change({ id: 'a', original: 'very very slowly', replacement: 'slowly' }),
      change({ id: 'b', original: 'over the water', replacement: '' }),
      change({ id: 'c', original: 'missing words', replacement: 'x' })
    ])
    expect(result.applied).toEqual(['a', 'b'])
    expect(result.stale).toEqual(['c'])
    expect(JSON.stringify(result.doc)).toContain('The harbour bell rang ')
    expect(JSON.stringify(result.doc)).not.toContain('over the water')
  })
})

describe('the tracked changes extension (F-14.15)', () => {
  it('strikes the passage, shows the replacement, routes the buttons, and reports a gone passage once', () => {
    const live = mount()
    const actions: string[] = []
    const stale: string[][] = []
    const storage = live.storage.trackedChanges
    if (!storage) throw new Error('no tracked changes storage')
    storage.onAction = (id, action) => actions.push(`${id}:${action}`)
    storage.onStale = (ids) => stale.push(ids)
    live.commands.setTrackedChanges([
      {
        id: 'c1',
        original: 'very very slowly',
        replacement: 'slowly',
        rationale: 'r',
        flagged: false
      },
      { id: 'c2', original: 'not there', replacement: 'x', rationale: '', flagged: false }
    ])
    const dom = live.view.dom
    expect(dom.querySelector(`.${TRACKED_DEL_CLASS}`)?.textContent).toBe('very very slowly')
    expect(dom.querySelector(`.${TRACKED_INS_CLASS}`)?.textContent).toBe('slowly')
    expect(live.state.doc.textContent).toBe(TEXT)
    expect(stale).toEqual([['c2']])

    dom
      .querySelector('.tracked-accept')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    dom
      .querySelector('.tracked-reject')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(actions).toEqual(['c1:accept', 'c1:reject'])

    // The author rewrites the passage: the change is orphaned and reported, never misapplied.
    const from = TEXT.indexOf('very') + 1
    live.commands.insertContentAt({ from, to: from + 'very very'.length }, 'quite')
    expect(dom.querySelector(`.${TRACKED_DEL_CLASS}`)).toBeNull()
    expect(stale).toEqual([['c2'], ['c1']])
  })
})

describe('one change at a time (2026-10-08, the review deck)', () => {
  it('steps through pending changes: jumps quietly, accepts, keeps for later, and ends', async () => {
    const second = change({
      id: 'c2',
      nodeId: 'sc-2',
      original: 'over the water',
      replacement: 'over the sea'
    })
    const note = change({ id: 'n1', kind: 'note', replacement: null })
    changes = [change(), second, note, change({ id: 'c3', status: 'accepted' })]
    registerTrackedEditor('sc-1', mount())
    store().startReview(changes, { 'sc-1': 'Scene 1', 'sc-2': 'Scene 2' })
    expect(store().review).toMatchObject({ currentId: 'c1', nodeId: 'sc-1', skipped: [] })
    // Only the pending tracked changes: no note, nothing settled.
    expect(store().review?.changes.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(store().focus).toEqual({
      changeId: 'c1',
      nodeId: 'sc-1',
      quote: 'rang very very slowly',
      quiet: true
    })

    await store().accept([change()])
    expect(settles).toEqual([{ ids: ['c1'], status: 'accepted' }])
    expect(store().review?.changes[0]?.status).toBe('accepted')

    store().reviewAt('c2')
    expect(store().review).toMatchObject({ currentId: 'c2', nodeId: 'sc-2' })
    expect(store().focus).toMatchObject({ changeId: 'c2', nodeId: 'sc-2', quiet: true })
    store().skipInReview(['c2'])
    store().skipInReview(['c2'])
    expect(store().review?.skipped).toEqual(['c2'])
    // The end keeps the strip on the last scene.
    store().reviewAt(null)
    expect(store().review).toMatchObject({ currentId: null, nodeId: 'sc-2' })
    store().endReview()
    expect(store().review).toBeNull()
  })

  it('says so when nothing is left to review', () => {
    store().startReview([change({ status: 'rejected' })], {})
    expect(store().review).toBeNull()
    expect(useDialogStore.getState().toasts.at(-1)?.message).toBe(
      'No tracked changes left to review.'
    )
  })
})
