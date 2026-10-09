import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type {
  EditChange,
  EditChangeStatus,
  EditPassDetail,
  EditPassPresets,
  EditPassSummary,
  EditPassType
} from '@shared/editPass'
import { EDIT_PASS_LABEL } from '@shared/editPass'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { locateAll } from '@renderer/features/editor/locateText'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { applyChangesToDoc, applyEditChange } from './applyChange'
import { useEditPassViewStore } from './editPassViewStore'

/**
 * The renderer owner of the edit passes (F-14.15): the passes (the Edit reports list), the
 * report on screen, the pending tracked changes of the scenes the editor shows, and the saved
 * custom presets. Main owns the run; this store starts, stops, and resumes it, hears every move
 * through `editPass:changed`, and settles changes as the author accepts or rejects them. A change
 * enters the manuscript only here, through `applyEditChange`: in the scene's mounted editor when
 * it has one (so undo and autosave see it), or through the document store's load / edit / unload
 * when the author accepts from the report with the scene closed.
 */

/**
 * Stepping through tracked changes one at a time (2026-10-08, the review deck): the changes of a
 * pass or a scene in reading order, the ones the author kept for later, and where the author is.
 * The deck shows as a strip above the editor of the change's scene, and the editor jumps to each.
 */
export interface EditReviewSession {
  changes: EditChange[]
  /** Scene titles, the deck's groups. */
  titles: Record<string, string>
  /** Changes the author skipped ("Later"): still pending, reviewable again. */
  skipped: string[]
  /** The change on show, or null at the end. */
  currentId: string | null
  /** The scene whose editor shows the strip: the current change's, or the last one's at the end. */
  nodeId: string
}

export interface StartPassInput {
  type: EditPassType
  instruction: string | null
  nodeIds: string[]
}

interface EditPassState {
  /** Every pass by id, and the newest-first order of the Edit reports list. */
  byId: Record<string, EditPassSummary>
  ids: string[]
  loaded: boolean
  /** The report on screen, refetched when its pass moves. */
  detail: EditPassDetail | null
  /** Pending tracked changes per scene the editor asked for. */
  changesByNode: Record<string, EditChange[]>
  presets: EditPassPresets
  /** The pass this window started; it opens its report when it finishes. */
  startedHere: string | null
  /** A change or note to show when its scene's editor mounts (a jump from the report). */
  focus: { changeId: string; nodeId: string; quote: string; quiet?: boolean } | null
  /** The one-at-a-time review under way, or null. */
  review: EditReviewSession | null
  /** Accepting or rejecting is in progress (the report's buttons wait for it). */
  busy: boolean

  load: () => Promise<void>
  clear: () => void
  openWorkspace: () => void
  openReport: (passId: string) => Promise<void>
  start: (input: StartPassInput) => Promise<boolean>
  cancel: (passId: string) => Promise<void>
  resume: (passId: string) => Promise<void>
  remove: (passId: string) => Promise<void>
  loadChanges: (nodeId: string) => Promise<void>
  /** Accepts changes (any scenes): applied to the text, then settled; a gone passage settles stale. */
  accept: (changes: readonly EditChange[]) => Promise<void>
  /** Rejects changes, or dismisses notes. */
  reject: (changes: readonly EditChange[]) => Promise<void>
  /** Marks developmental notes addressed. */
  markDone: (changes: readonly EditChange[]) => Promise<void>
  /**
   * Opens the change's scene with the change highlighted; `quiet` leaves the keyboard focus
   * where it is (the review deck keeps it).
   */
  jump: (change: EditChange, options?: { quiet?: boolean }) => void
  /** Starts the one-at-a-time review over these changes (only pending tracked changes count). */
  startReview: (changes: readonly EditChange[], titles: Record<string, string>) => void
  /** The deck moved to another change (or to the end): the editor follows. */
  reviewAt: (id: string | null) => void
  /** Keeps changes for later in the review. */
  skipInReview: (ids: readonly string[]) => void
  endReview: () => void
  savePresets: (presets: EditPassPresets) => Promise<void>
  /** Settles changes whose passage the editor could no longer find. */
  markStale: (ids: readonly string[]) => Promise<void>
}

/** The subscription to main's pass events; one for the renderer, opened by the first load. */
let unsubscribe: (() => void) | null = null
/** Bumped by every load() and clear() so an answer for a closed project is dropped. */
let generation = 0
/** The editors showing a scene with tracked changes, by scene id (the accept path uses them). */
const mounted = new Map<string, Editor>()

/** Lets the accept path reach a scene's live editor; returns the unregister. */
export function registerTrackedEditor(nodeId: string, editor: Editor): () => void {
  mounted.set(nodeId, editor)
  return () => {
    if (mounted.get(nodeId) === editor) mounted.delete(nodeId)
  }
}

/** The running pass, if any. */
export function runningPass(state: Pick<EditPassState, 'byId' | 'ids'>): EditPassSummary | null {
  for (const id of state.ids) {
    const pass = state.byId[id]
    if (pass?.status === 'running') return pass
  }
  return null
}

/** Whether a scene is in the running pass, so the editor holds it read-only (F-14.15). */
export function useSceneLocked(nodeId: string): EditPassSummary | null {
  return useEditPassStore((s) => {
    const pass = runningPass(s)
    return pass?.nodeIds.includes(nodeId) ? pass : null
  })
}

function upsert(summary: EditPassSummary): void {
  const { byId, ids } = useEditPassStore.getState()
  useEditPassStore.setState({
    byId: { ...byId, [summary.id]: summary },
    ids: ids.includes(summary.id) ? ids : [summary.id, ...ids]
  })
}

/** Groups changes by scene, in the order given. */
function byScene(changes: readonly EditChange[]): Map<string, EditChange[]> {
  const groups = new Map<string, EditChange[]>()
  for (const change of changes) {
    const group = groups.get(change.nodeId) ?? []
    group.push(change)
    groups.set(change.nodeId, group)
  }
  return groups
}

/** Records what main settled: the scene lists drop the rows, the open report shows their status. */
function applySettled(moved: readonly EditChange[]): void {
  if (moved.length === 0) return
  const status = new Map(moved.map((change) => [change.id, change.status]))
  const { changesByNode, detail } = useEditPassStore.getState()
  const nextByNode: Record<string, EditChange[]> = { ...changesByNode }
  for (const nodeId of new Set(moved.map((change) => change.nodeId))) {
    const list = nextByNode[nodeId]
    if (list) nextByNode[nodeId] = list.filter((change) => !status.has(change.id))
  }
  const review = useEditPassStore.getState().review
  useEditPassStore.setState({
    changesByNode: nextByNode,
    review:
      review === null
        ? null
        : {
            ...review,
            changes: review.changes.map((change) => {
              const next = status.get(change.id)
              return next === undefined ? change : { ...change, status: next }
            })
          },
    detail:
      detail === null
        ? null
        : {
            ...detail,
            changes: detail.changes.map((change) => {
              const next = status.get(change.id)
              return next === undefined ? change : { ...change, status: next }
            })
          }
  })
}

async function settle(
  ids: readonly string[],
  status: Exclude<EditChangeStatus, 'pending'>
): Promise<void> {
  if (ids.length === 0) return
  const moved = await ipc().invoke('editPass:settle', { ids: [...ids], status })
  applySettled(moved)
}

/**
 * Applies one scene's changes: in its live editor (one transaction per change, so each undoes on
 * its own) or, with the scene closed, through the document store, which saves it like typing.
 * Answers which changes landed and which passages were gone.
 */
async function applyScene(
  nodeId: string,
  changes: readonly EditChange[]
): Promise<{ applied: string[]; stale: string[] }> {
  const editor = mounted.get(nodeId)
  if (editor && !editor.isDestroyed) {
    const applied: string[] = []
    const stale: string[] = []
    for (const change of changes) {
      const range = locateAll(editor.state.doc, [change.original])[0] ?? null
      const tr = editor.state.tr
      if (range === null || !applyEditChange(tr, range, change)) {
        stale.push(change.id)
        continue
      }
      editor.view.dispatch(tr)
      applied.push(change.id)
    }
    return { applied, stale }
  }
  const documents = useDocumentStore.getState()
  await documents.load(nodeId)
  try {
    const content = useDocumentStore.getState().docs[nodeId]?.content ?? null
    if (content === null) return { applied: [], stale: changes.map((change) => change.id) }
    const result = applyChangesToDoc(content, changes)
    if (result.applied.length > 0) useDocumentStore.getState().edit(nodeId, result.doc)
    return { applied: result.applied, stale: result.stale }
  } finally {
    useDocumentStore.getState().unload(nodeId)
  }
}

async function refreshDetail(passId: string): Promise<void> {
  const mine = generation
  const detail = await ipc().invoke('editPass:get', { id: passId })
  if (mine !== generation) return
  if (useEditPassStore.getState().detail?.pass.id !== passId) return
  useEditPassStore.setState({ detail })
}

function onChanged(summary: EditPassSummary): void {
  const before = useEditPassStore.getState().byId[summary.id]
  upsert(summary)
  const state = useEditPassStore.getState()
  // A finished scene's changes are now in main: a scene already showing re-reads its list.
  const finished = summary.doneNodeIds.filter((id) => !(before?.doneNodeIds ?? []).includes(id))
  for (const nodeId of finished) {
    if (state.changesByNode[nodeId] !== undefined) void state.loadChanges(nodeId)
  }
  if (state.detail?.pass.id === summary.id) {
    refreshDetail(summary.id).catch(() => undefined)
  }
  if (before?.status === 'running' && summary.status !== 'running') {
    // The scenes unlock; their tracked changes show from here on.
    for (const nodeId of summary.nodeIds) {
      if (state.changesByNode[nodeId] !== undefined) void state.loadChanges(nodeId)
    }
    if (state.startedHere === summary.id) {
      useEditPassStore.setState({ startedHere: null })
      const label = EDIT_PASS_LABEL[summary.type]
      if (summary.status === 'done') {
        toast.success(`${label} finished. The report is open.`)
        void state.openReport(summary.id)
      } else if (summary.status === 'failed') {
        toast.error(`${label} stopped: ${summary.error ?? 'the pass failed.'}`)
      }
    }
  }
}

export const useEditPassStore = create<EditPassState>((set, get) => ({
  byId: {},
  ids: [],
  loaded: false,
  detail: null,
  changesByNode: {},
  presets: [],
  startedHere: null,
  focus: null,
  review: null,
  busy: false,

  async load() {
    unsubscribe ??= ipc().on('editPass:changed', onChanged)
    const mine = ++generation
    const [passes, presets] = await Promise.all([
      ipc().invoke('editPass:list', undefined),
      ipc().invoke('editPass:presets', undefined)
    ])
    if (mine !== generation) return
    set({
      byId: Object.fromEntries(passes.map((pass) => [pass.id, pass])),
      ids: passes.map((pass) => pass.id),
      presets,
      loaded: true
    })
  },

  clear() {
    generation++
    mounted.clear()
    useEditPassViewStore.getState().close()
    set({
      byId: {},
      ids: [],
      loaded: false,
      detail: null,
      changesByNode: {},
      presets: [],
      startedHere: null,
      focus: null,
      review: null,
      busy: false
    })
  },

  openWorkspace() {
    useEntityStore.getState().select(null)
    useEditPassViewStore.getState().open({ kind: 'workspace' })
  },

  async openReport(passId) {
    useEntityStore.getState().select(null)
    useEditPassViewStore.getState().open({ kind: 'report', passId })
    if (get().detail?.pass.id !== passId) set({ detail: null })
    const mine = generation
    try {
      const detail = await ipc().invoke('editPass:get', { id: passId })
      if (mine !== generation) return
      const view = useEditPassViewStore.getState().view
      if (view?.kind === 'report' && view.passId === passId) set({ detail })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async start(input) {
    try {
      // Main reads the saved scenes: everything typed so far goes first.
      await flushPendingSaves()
      const result = await ipc().invoke('editPass:start', input)
      if (!result.ok) {
        toast.error(`${result.message} ${result.nextStep}`.trim())
        return false
      }
      upsert(result.pass)
      set({ startedHere: result.pass.id })
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    }
  },

  async cancel(passId) {
    try {
      await ipc().invoke('editPass:cancel', { id: passId })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async resume(passId) {
    try {
      await flushPendingSaves()
      const result = await ipc().invoke('editPass:resume', { id: passId })
      if (!result.ok) {
        toast.error(`${result.message} ${result.nextStep}`.trim())
        return
      }
      upsert(result.pass)
      set({ startedHere: result.pass.id })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async remove(passId) {
    try {
      await ipc().invoke('editPass:delete', { id: passId })
      const byId = { ...get().byId }
      delete byId[passId]
      set({ byId, ids: get().ids.filter((id) => id !== passId) })
      const view = useEditPassViewStore.getState().view
      if (view?.kind === 'report' && view.passId === passId) {
        useEditPassViewStore.getState().close()
        set({ detail: null })
      }
      // The deleted pass's tracked changes leave the scenes showing them.
      const changesByNode: Record<string, EditChange[]> = {}
      for (const [nodeId, list] of Object.entries(get().changesByNode)) {
        changesByNode[nodeId] = list.filter((change) => change.passId !== passId)
      }
      set({ changesByNode })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async loadChanges(nodeId) {
    const mine = generation
    try {
      const changes = await ipc().invoke('editPass:changes', { nodeId })
      if (mine !== generation) return
      set({ changesByNode: { ...get().changesByNode, [nodeId]: changes } })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async accept(changes) {
    const pending = changes.filter((c) => c.status === 'pending' && c.kind === 'change')
    if (pending.length === 0 || get().busy) return
    set({ busy: true })
    try {
      const applied: string[] = []
      const stale: string[] = []
      for (const [nodeId, group] of byScene(pending)) {
        // The run reads the saved scenes; a scene still in the running pass is not touched.
        const running = runningPass(get())
        if (running?.nodeIds.includes(nodeId)) continue
        const result = await applyScene(nodeId, group)
        applied.push(...result.applied)
        stale.push(...result.stale)
      }
      await settle(applied, 'accepted')
      await settle(stale, 'stale')
      if (stale.length > 0) {
        toast.warning(
          stale.length === 1
            ? 'One change could not be applied: its passage has changed since the pass.'
            : `${stale.length} changes could not be applied: their passages have changed since the pass.`
        )
      }
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      set({ busy: false })
    }
  },

  async reject(changes) {
    const ids = changes.filter((c) => c.status === 'pending').map((c) => c.id)
    try {
      await settle(ids, 'rejected')
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async markDone(changes) {
    const ids = changes.filter((c) => c.status === 'pending' && c.kind === 'note').map((c) => c.id)
    try {
      await settle(ids, 'accepted')
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  jump(change, options) {
    set({
      focus: {
        changeId: change.id,
        nodeId: change.nodeId,
        quote: change.original,
        quiet: options?.quiet === true
      }
    })
    // Selecting the scene closes the report, like picking a document closes an entity page.
    useTreeStore.getState().select(change.nodeId)
  },

  startReview(changes, titles) {
    const pending = changes.filter((c) => c.kind === 'change' && c.status === 'pending')
    const first = pending[0]
    if (first === undefined) {
      toast.info('No tracked changes left to review.')
      return
    }
    set({
      review: { changes: pending, titles, skipped: [], currentId: first.id, nodeId: first.nodeId }
    })
    get().jump(first, { quiet: true })
  },

  reviewAt(id) {
    const review = get().review
    if (review === null || review.currentId === id) return
    const change = id === null ? undefined : review.changes.find((c) => c.id === id)
    set({
      review: { ...review, currentId: id, nodeId: change?.nodeId ?? review.nodeId }
    })
    if (change !== undefined) get().jump(change, { quiet: true })
  },

  skipInReview(ids) {
    const review = get().review
    if (review === null) return
    set({ review: { ...review, skipped: [...new Set([...review.skipped, ...ids])] } })
  },

  endReview() {
    set({ review: null })
  },

  async savePresets(presets) {
    const before = get().presets
    set({ presets })
    try {
      set({ presets: await ipc().invoke('editPass:setPresets', presets) })
    } catch (err) {
      set({ presets: before })
      toast.error(describeError(err))
    }
  },

  async markStale(ids) {
    try {
      await settle(ids, 'stale')
    } catch (err) {
      toast.error(describeError(err))
    }
  }
}))

/** Empties the store, drops the subscription and the editor registry. For tests only. */
export function resetEditPassStore(): void {
  unsubscribe?.()
  unsubscribe = null
  generation = 0
  mounted.clear()
  useEditPassStore.setState({
    byId: {},
    ids: [],
    loaded: false,
    detail: null,
    changesByNode: {},
    presets: [],
    startedHere: null,
    focus: null,
    review: null,
    busy: false
  })
}
