import { create } from 'zustand'
import {
  orderedCategories,
  type EditFlowCategory,
  type EditFlowDepth,
  type EditFlowDetail,
  type EditFlowIssue,
  type EditFlowRun,
  type EditFlowScopeKind,
  type EditFlowSpec
} from '@shared/editFlow'
import { openSceneNow, type OpenScene } from '@renderer/features/ai/aiActions'
import { undoNotebookEdit } from '@renderer/features/ai/agentApply'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The edit flow's renderer owner (notes redesign phase 2): whether its panel shows in the right
 * column, the choices on its set-up (stages and checks, scope, depth), the runs main keeps (the
 * latest per scope), and the run whose results show. Main owns the run; this store starts and
 * stops it and hears every move through `editFlow:changed`. A fix is an edit-pass change, so
 * accepting or rejecting one goes through the edit-pass store (the same path as the editor's
 * inline buttons), which settles it in main; the run's event then refreshes the results.
 */

export const EDIT_FLOW_NO_SCENE = 'Open a scene first.'
export const EDIT_FLOW_NO_CHAPTER = 'This scene is not in a chapter.'
export const EDIT_FLOW_PICK_ONE = 'Pick at least one stage or check.'

/** What the chat (or a test) may set when it opens the flow. */
export interface EditFlowPrefill {
  categories?: EditFlowCategory[]
  scope?: EditFlowScopeKind
  /** The chapter a request named ("edit chapter 3"), in place of the open scene's. */
  chapterId?: string | null
  depth?: EditFlowDepth
}

interface EditFlowState {
  /** The panel shows in the right column in place of the chat. */
  open: boolean
  categories: EditFlowCategory[]
  depth: EditFlowDepth
  scope: EditFlowScopeKind
  /** A chapter the chat named, used while the scope is This chapter; null: the open scene's. */
  chapterId: string | null
  /** The kept runs, newest first. */
  runs: EditFlowRun[]
  loaded: boolean
  /** The run whose results show; null shows the set-up. */
  shownId: string | null
  detail: EditFlowDetail | null
  starting: boolean

  load: () => Promise<void>
  clear: () => void
  openFlow: (prefill?: EditFlowPrefill) => void
  close: () => void
  toggleCategory: (category: EditFlowCategory) => void
  setDepth: (depth: EditFlowDepth) => void
  setScope: (scope: EditFlowScopeKind) => void
  /** Starts a run of `spec`; its results show at once and fill in as it goes. */
  start: (spec: EditFlowSpec) => Promise<boolean>
  cancel: (runId: string) => Promise<void>
  /** Shows a run's results, or the set-up with null. */
  show: (runId: string | null) => Promise<void>
  accept: (issue: EditFlowIssue) => Promise<void>
  reject: (issue: EditFlowIssue) => Promise<void>
  /** Opens the issue's scene with its passage selected at the middle of the view. */
  jump: (issue: EditFlowIssue) => Promise<void>
  /** Undoes one of Update notes' edits of the shown run. */
  undoNote: (index: number) => Promise<void>
}

let unsubscribe: (() => void) | null = null
/** Bumped by every load() and clear() so an answer for a closed project is dropped. */
let generation = 0

/**
 * The run's spec for the open scene, or why there is none: this scene, its chapter (the folder
 * it sits in, not a section root), or the whole book.
 */
export function specFor(
  state: Pick<EditFlowState, 'categories' | 'depth' | 'scope' | 'chapterId'>,
  open: Pick<OpenScene, 'nodeId' | 'scene'>
): EditFlowSpec | string {
  if (state.categories.length === 0) return EDIT_FLOW_PICK_ONE
  const categories = orderedCategories(state.categories)
  if (state.scope === 'book') {
    return { categories, depth: state.depth, scope: { kind: 'book', nodeId: null } }
  }
  if (state.scope === 'chapter' && state.chapterId !== null) {
    return { categories, depth: state.depth, scope: { kind: 'chapter', nodeId: state.chapterId } }
  }
  if (!open.scene || open.nodeId === null) return EDIT_FLOW_NO_SCENE
  if (state.scope === 'scene') {
    return { categories, depth: state.depth, scope: { kind: 'scene', nodeId: open.nodeId } }
  }
  const tree = useTreeStore.getState()
  const parent = tree.byId[open.nodeId]?.parentId ?? null
  if (parent === null || tree.rootIds.includes(parent)) return EDIT_FLOW_NO_CHAPTER
  return { categories, depth: state.depth, scope: { kind: 'chapter', nodeId: parent } }
}

/** The run's spec for the scene open now (outside React). */
export function specNow(): EditFlowSpec | string {
  return specFor(useEditFlowStore.getState(), openSceneNow())
}

async function refreshDetail(runId: string): Promise<void> {
  const mine = generation
  const detail = await ipc().invoke('editFlow:get', { id: runId })
  if (mine !== generation || useEditFlowStore.getState().shownId !== runId) return
  useEditFlowStore.setState({ detail })
}

function upsert(run: EditFlowRun): void {
  const { runs } = useEditFlowStore.getState()
  const at = runs.findIndex((entry) => entry.id === run.id)
  useEditFlowStore.setState({
    runs: at < 0 ? [run, ...runs] : runs.map((entry) => (entry.id === run.id ? run : entry))
  })
}

function onChanged(run: EditFlowRun): void {
  upsert(run)
  // The scenes the editor shows re-read their tracked changes: a request may have added fixes.
  const passes = useEditPassStore.getState()
  for (const nodeId of Object.keys(passes.changesByNode)) void passes.loadChanges(nodeId)
  if (useEditFlowStore.getState().shownId === run.id) {
    refreshDetail(run.id).catch(() => undefined)
  }
}

export const useEditFlowStore = create<EditFlowState>((set, get) => ({
  open: false,
  categories: ['copy'],
  depth: 'quick',
  scope: 'scene',
  chapterId: null,
  runs: [],
  loaded: false,
  shownId: null,
  detail: null,
  starting: false,

  async load() {
    unsubscribe ??= ipc().on('editFlow:changed', onChanged)
    const mine = ++generation
    const runs = await ipc().invoke('editFlow:list', undefined)
    if (mine !== generation) return
    set({ runs, loaded: true })
  },

  clear() {
    generation++
    set({ open: false, runs: [], loaded: false, shownId: null, detail: null, starting: false })
  },

  openFlow(prefill) {
    set({
      open: true,
      shownId: null,
      detail: null,
      ...(prefill?.categories && prefill.categories.length > 0
        ? { categories: orderedCategories(prefill.categories) }
        : {}),
      ...(prefill?.scope ? { scope: prefill.scope } : {}),
      chapterId: prefill?.chapterId ?? null,
      ...(prefill?.depth ? { depth: prefill.depth } : {})
    })
  },

  close() {
    set({ open: false })
  },

  toggleCategory(category) {
    const { categories } = get()
    set({
      categories: categories.includes(category)
        ? categories.filter((entry) => entry !== category)
        : orderedCategories([...categories, category])
    })
  },

  setDepth(depth) {
    set({ depth })
  },

  setScope(scope) {
    set({ scope, chapterId: null })
  },

  async start(spec) {
    if (get().starting) return false
    set({ starting: true })
    try {
      // Main reads the saved scenes: everything typed so far goes first.
      await flushPendingSaves()
      const result = await ipc().invoke('editFlow:start', spec)
      if (!result.ok) {
        toast.error(`${result.message} ${result.nextStep}`.trim())
        return false
      }
      // A run of the same scope replaced the one before it.
      const key = JSON.stringify(spec.scope)
      set({
        runs: [
          result.run,
          ...get().runs.filter((run) => JSON.stringify(run.spec.scope) !== key)
        ]
      })
      await get().show(result.run.id)
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    } finally {
      set({ starting: false })
    }
  },

  async cancel(runId) {
    try {
      await ipc().invoke('editFlow:cancel', { id: runId })
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async show(runId) {
    set({ shownId: runId, detail: get().detail?.run.id === runId ? get().detail : null })
    if (runId === null) return
    try {
      await refreshDetail(runId)
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async accept(issue) {
    await useEditPassStore.getState().accept([issue])
  },

  async reject(issue) {
    await useEditPassStore.getState().reject([issue])
  },

  async jump(issue) {
    await openPassage(issue.nodeId, (doc) => locateText(doc, issue.original), { centre: true })
  },

  async undoNote(index) {
    const run = get().detail?.run
    const entry = run?.noteEdits[index]
    if (run === undefined || entry === undefined || entry.undone || entry.edit.kind !== 'notebook') {
      return
    }
    try {
      await undoNotebookEdit(entry.edit)
      const next = await ipc().invoke('editFlow:noteUndone', { id: run.id, index })
      upsert(next)
      const detail = get().detail
      if (detail?.run.id === next.id) set({ detail: { ...detail, run: next } })
    } catch (err) {
      toast.error(describeError(err))
    }
  }
}))

/** Empties the store and drops the subscription. For tests only. */
export function resetEditFlowStore(): void {
  unsubscribe?.()
  unsubscribe = null
  generation = 0
  useEditFlowStore.setState({
    open: false,
    categories: ['copy'],
    depth: 'quick',
    scope: 'scene',
    chapterId: null,
    runs: [],
    loaded: false,
    shownId: null,
    detail: null,
    starting: false
  })
}
