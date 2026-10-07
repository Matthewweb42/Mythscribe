import { create } from 'zustand'
import { DEFAULT_MODELS } from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import { baseName, type ImportDraft, type ImportPlacement } from '@shared/import'
import {
  estimateStructureCost,
  flattenDraft,
  type ImportDetectProgress,
  type StructureEstimate
} from '@shared/importStructure'
import type { NovelFormat } from '@shared/ipc/contract'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { providerOf, routedTier, useAiStore } from '@renderer/features/ai/aiStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { refreshRewrittenDocuments } from '@renderer/features/editor/rewrittenDocuments'
import { buildIndex, expandAncestors, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import {
  applyStructure,
  findNode,
  idsOfKind,
  mergeChapters,
  mergeScenes,
  mergeWithNext,
  moveTo,
  rejectSuggestion,
  removeNodes,
  renameNode,
  setPlacement,
  shiftNode,
  splitScene,
  type DropZone
} from './draftEdits'

/** Where the optional AI structure pass (F-12.3) stands for the draft under review. */
export type DetectStatus = 'offer' | 'running' | 'done' | 'failed' | 'skipped'

/** What a finished pass cost and what it changed, for the dialog's one line about it. */
export interface DetectOutcome {
  costUsd: number
  model: string
  chunks: number
  added: number
  titled: number
}

/**
 * The AI pass over the draft (F-12.3): the offer with its estimate, the run, and what came of
 * it. Null while no pass is possible — the dial or the toggle is off (F-14.4), the draft has
 * no words left to send, or the import starts a new project (it has no AI settings yet).
 */
export interface DetectState {
  status: DetectStatus
  /** Words the pass would send: the imported (not existing) ones, recomputed on every edit. */
  words: number
  estimate: StructureEstimate
  /** The id `ai:cancel` finds while the pass runs (F-5.10); null otherwise. */
  requestId: string | null
  /** Chunks answered so far and the spend so far, as main pushes it; null outside a run. */
  progress: ImportDetectProgress | null
  outcome: DetectOutcome | null
  /** An expected AI failure the author can act on (no key, the cap, the dial). */
  error: { message: string; nextStep: string } | null
  /** One pending proposal per chunk (F-14.5), settled at Import or when the draft is dropped. */
  proposalIds: string[]
  /** Suggestions the author rejected; decides `accepted` against `acceptedPart` at Import. */
  rejected: number
}

/** Where Import writes: into the open project, or a new project (the welcome screen's import). */
export type ImportTarget = 'project' | 'new'

/** Undo steps the review keeps; older edits fall off. */
export const IMPORT_UNDO_MAX = 100

/** The subscription to main's chunk progress; one for the renderer, opened by the first pass. */
let unsubscribe: (() => void) | null = null
let counter = 0
/** A request id `ai:cancel` can find (F-5.10), unique across this renderer's passes. */
const nextRequestId = (): string => `imp-${Date.now().toString(36)}-${++counter}`

/**
 * The model the pass would run on: the tier the import routes to (fast unless the author
 * overrode it) of the provider this project's source sends through (F-15.4, 2026-10-07).
 */
function fastModel(): string {
  const source = useAiSettingsStore.getState().settings?.source ?? 'ownKey'
  const { status, choice } = useAiStore.getState()
  const tier = routedTier(choice, source, 'importStructure', 'fast')
  return status?.models[providerOf(status, source)][tier] ?? DEFAULT_MODELS[tier]
}

/** What the pass over the draft as it stands would cost, from the words that would really be sent. */
function estimateFor(draft: ImportDraft): { words: number; estimate: StructureEstimate } {
  const words = flattenDraft(draft).reduce((total, paragraph) => total + paragraph.words, 0)
  return { words, estimate: estimateStructureCost(words, fastModel()) }
}

/** The offer for a fresh draft, or null when the feature is not allowed or there is nothing to send. */
function offerFor(draft: ImportDraft): DetectState | null {
  const settings = useAiSettingsStore.getState().settings
  if (settings === null || !isFeatureAllowed(settings, 'importStructure')) return null
  const { words, estimate } = estimateFor(draft)
  if (estimate.chunks === 0) return null
  return {
    status: 'offer',
    words,
    estimate,
    requestId: null,
    progress: null,
    outcome: null,
    error: null,
    proposalIds: [],
    rejected: 0
  }
}

/** One more chunk was answered; the panel shows how far the pass has got and what it has spent. */
function onProgress(progress: ImportDetectProgress): void {
  useImportStore.setState((s) =>
    s.detect?.status === 'running' ? { detect: { ...s.detect, progress } } : {}
  )
}

/**
 * Settles the chunk proposals the pass left pending (F-14.5): `accepted` when the author kept
 * every suggestion, `acceptedPart` when they rejected some, `rejected` when the draft is dropped.
 */
function settleChunks(detect: DetectState | null, imported: boolean): void {
  if (detect === null) return
  const status = imported ? (detect.rejected === 0 ? 'accepted' : 'acceptedPart') : 'rejected'
  for (const id of detect.proposalIds) void proposalStore.settle(id, status, null)
}

/**
 * Manuscript import (F-12.2), the renderer's half: main reads the file and answers a structure
 * draft (into a project with content, the combined outline of its existing nodes and the
 * imported ones), this store holds it while the author corrects it in the review dialog, and
 * Import hands the edited draft back in one call — into the open project, or, from the welcome
 * screen, into a new project that then opens. Nothing is written until then — Cancel simply
 * drops the draft — and every edit goes through the pure functions in `draftEdits`, so the
 * store owns only *which* draft is under review (and the earlier ones, for Undo), not how it
 * changes. The AI pass (F-12.3) is one more thing that can change the draft: it is offered with
 * its cost before anything is sent, runs in main chunk by chunk, and its suggestions are merged
 * in by `applyStructure`; while it runs the draft is frozen, because its indices are global
 * over the draft it was given.
 */
interface ImportState {
  /** The draft under review, or null when no import is in progress. */
  draft: ImportDraft | null
  /** Into the open project, or a new one created at Import (no project was open at `open()`). */
  target: ImportTarget
  /** The new project's name (target `new`), the file's name to start with. */
  projectName: string
  /** The new project's format (target `new`), Novel to start with. */
  projectFormat: NovelFormat
  /** The scene whose paragraphs the dialog shows beside the tree (for splitting), if any. */
  sceneId: string | null
  /** True while main is reading the file or writing the draft; the dialog's buttons disable on it. */
  busy: boolean
  /** The node whose title is being edited inline in the dialog, if any. */
  renamingId: string | null
  /** Rows ticked for Merge into one scene / Delete selected, in the order they were ticked. */
  selected: string[]
  /** The row a shift-click range starts from: the last one ticked without Shift. */
  anchor: string | null
  /** Earlier drafts, newest last, for Undo (Ctrl+Z); cleared when the AI pass rewrites the draft. */
  history: ImportDraft[]
  /** The AI structure pass (F-12.3) for this draft, or null when it cannot be offered. */
  detect: DetectState | null
  /** Asks main for a draft (a `path` skips the native dialog, as `project:open` does). */
  open: (path?: string) => Promise<void>
  /** Shows a scene's paragraphs beside the tree, or clears the pane with null. */
  selectScene: (id: string | null) => void
  startRename: (id: string) => void
  endRename: () => void
  rename: (id: string, title: string) => void
  setPlacement: (chapterId: string, placement: ImportPlacement) => void
  /** Move up / Move down, crossing into the neighbouring chapter or part at either end. */
  move: (id: string, by: -1 | 1) => void
  /** Drag and drop: before or after a row of the same level, or into the level above. */
  moveTo: (id: string, targetId: string, zone: DropZone) => void
  /** The row's ×: the node and whatever is inside it leave the outline. */
  remove: (id: string) => void
  mergeWithNext: (id: string) => void
  splitScene: (sceneId: string, paragraphIndex: number) => void
  /** Ticks or unticks a row; with `range`, every row of its level from the anchor to it. */
  toggleSelect: (id: string, range: boolean) => void
  clearSelection: () => void
  /** Merge into one scene (or chapter): the ticked rows, all of one level, become the first. */
  mergeSelected: () => void
  removeSelected: () => void
  /** Steps back one edit. */
  undo: () => void
  setProjectName: (name: string) => void
  setProjectFormat: (format: NovelFormat) => void
  /** Runs the AI pass and merges what it suggests into the draft. Ignored unless it is on offer. */
  startDetect: () => Promise<void>
  /** Stops a running pass; main answers CANCELLED and the draft stays as the heuristics left it. */
  cancelDetect: () => void
  /** Keeps the heuristic draft: the offer goes away and nothing is sent. */
  skipDetect: () => void
  /** Undoes one suggestion (a scene or chapter the pass added) and counts it against the proposal. */
  rejectSuggestion: (id: string) => void
  /**
   * Writes the reviewed draft: into the open project (the tree index is rebuilt from main's
   * answer, rewritten documents are read again, the first created scene is selected), or into a
   * new project that then opens.
   */
  commit: () => Promise<void>
  /** Drops the draft; nothing was written. */
  cancel: () => void
}

/** Bumped by every cancel() and commit() so a response from a superseded import is dropped. */
let generation = 0

/** Everything an import holds, back to nothing under review. */
const CLEARED = {
  draft: null,
  sceneId: null,
  renamingId: null,
  busy: false,
  detect: null,
  selected: [],
  anchor: null,
  history: []
} satisfies Partial<ImportState>

/**
 * What follows any new draft: the selection, the anchor, and the paragraph pane drop ids that
 * left it, and the AI offer's estimate follows the words, so deleting half the book halves the
 * price shown.
 */
function follow(
  s: ImportState,
  draft: ImportDraft
): Pick<ImportState, 'selected' | 'anchor' | 'sceneId' | 'detect'> {
  const present = (id: string): boolean => findNode(draft, id) !== null
  return {
    selected: s.selected.filter(present),
    anchor: s.anchor !== null && present(s.anchor) ? s.anchor : null,
    sceneId: s.sceneId !== null && present(s.sceneId) ? s.sceneId : null,
    detect: s.detect?.status === 'offer' ? { ...s.detect, ...estimateFor(draft) } : s.detect
  }
}

/**
 * Applies one pure edit to the draft under review and keeps the one before it for Undo; without
 * a draft nothing happens, and neither does anything while the AI pass runs — its suggestions
 * are indices into the draft it was given.
 */
function edit(change: (draft: ImportDraft) => ImportDraft): void {
  useImportStore.setState((s) => {
    if (s.draft === null || s.detect?.status === 'running') return {}
    const draft = change(s.draft)
    if (draft === s.draft) return {}
    const history = [...s.history, s.draft].slice(-IMPORT_UNDO_MAX)
    return { draft, history, ...follow(s, draft) }
  })
}

export const useImportStore = create<ImportState>((set, get) => ({
  ...CLEARED,
  target: 'project',
  projectName: '',
  projectFormat: 'novel',

  async open(path) {
    if (get().busy) return
    const mine = generation
    const target: ImportTarget = useProjectStore.getState().current === null ? 'new' : 'project'
    set({ busy: true })
    try {
      // The open project's scenes travel in the draft with their stored text, so the editor's
      // unsaved typing is written first.
      if (target === 'project') await flushPendingSaves()
      const draft = await ipc().invoke('import:open', path === undefined ? {} : { path })
      if (mine !== generation) return
      // Null is the native dialog cancelled: no draft, no message, nothing to undo.
      if (draft) {
        set({
          ...CLEARED,
          busy: true,
          draft,
          target,
          projectName: baseName(draft.source.name),
          projectFormat: 'novel',
          // A new project has no AI settings yet, so the pass is offered only into a project.
          detect: target === 'project' ? offerFor(draft) : null
        })
      }
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      if (mine === generation) set({ busy: false })
    }
  },

  selectScene(id) {
    set({ sceneId: id })
  },

  startRename(id) {
    set({ renamingId: id })
  },

  endRename() {
    set((s) => (s.renamingId === null ? {} : { renamingId: null }))
  },

  rename(id, title) {
    edit((draft) => renameNode(draft, id, title))
    set({ renamingId: null })
  },

  setPlacement(chapterId, placement) {
    edit((draft) => setPlacement(draft, chapterId, placement))
  },

  move(id, by) {
    edit((draft) => shiftNode(draft, id, by))
  },

  moveTo(id, targetId, zone) {
    edit((draft) => moveTo(draft, id, targetId, zone))
  },

  remove(id) {
    edit((draft) => removeNodes(draft, [id]))
  },

  mergeWithNext(id) {
    edit((draft) => mergeWithNext(draft, id))
  },

  splitScene(sceneId, paragraphIndex) {
    edit((draft) => splitScene(draft, sceneId, paragraphIndex))
  },

  toggleSelect(id, range) {
    set((s) => {
      if (s.draft === null) return {}
      const found = findNode(s.draft, id)
      if (!found) return {}
      const anchorKind = s.anchor === null ? null : findNode(s.draft, s.anchor)?.kind
      if (range && s.anchor !== null && anchorKind === found.kind) {
        const order = idsOfKind(s.draft, found.kind)
        const from = order.indexOf(s.anchor)
        const to = order.indexOf(id)
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1)
        return { selected: [...s.selected, ...span.filter((each) => !s.selected.includes(each))] }
      }
      const selected = s.selected.includes(id)
        ? s.selected.filter((each) => each !== id)
        : [...s.selected, id]
      return { selected, anchor: id }
    })
  },

  clearSelection() {
    set({ selected: [], anchor: null })
  },

  mergeSelected() {
    const { draft, selected } = get()
    if (draft === null) return
    const kinds = new Set(selected.map((id) => findNode(draft, id)?.kind))
    if (kinds.size !== 1) return
    if (kinds.has('scene')) edit((d) => mergeScenes(d, selected))
    else if (kinds.has('chapter')) edit((d) => mergeChapters(d, selected))
    else return
    set({ selected: [], anchor: null })
  },

  removeSelected() {
    const selected = get().selected
    if (selected.length === 0) return
    edit((draft) => removeNodes(draft, selected))
    set({ selected: [], anchor: null })
  },

  undo() {
    set((s) => {
      const previous = s.history.at(-1)
      if (s.draft === null || previous === undefined || s.detect?.status === 'running') return {}
      return {
        draft: previous,
        history: s.history.slice(0, -1),
        renamingId: null,
        ...follow(s, previous)
      }
    })
  },

  setProjectName(name) {
    set({ projectName: name })
  },

  setProjectFormat(format) {
    set({ projectFormat: format })
  },

  async startDetect() {
    const { draft, detect } = get()
    if (draft === null || detect === null) return
    if (detect.status !== 'offer' && detect.status !== 'failed') return
    unsubscribe ??= ipc().on('import:detectProgress', onProgress)
    const requestId = nextRequestId()
    const mine = generation
    set({
      detect: {
        ...detect,
        status: 'running',
        requestId,
        error: null,
        progress: { done: 0, total: detect.estimate.chunks, costUsd: 0 }
      }
    })
    let result
    try {
      result = await useAiActivityStore
        .getState()
        .track(
          'importStructure',
          requestId,
          ipc().invoke('import:detectStructure', { draft, requestId })
        )
    } catch (err) {
      if (mine === generation && get().detect?.requestId === requestId) {
        set((s) =>
          s.detect === null
            ? {}
            : {
                detect: {
                  ...s.detect,
                  status: 'failed',
                  requestId: null,
                  progress: null,
                  error: { message: describeError(err), nextStep: '' }
                }
              }
        )
      }
      return
    }
    const held = get().detect
    // The import was cancelled or a newer pass started while this one ran: nothing shows it, so
    // the chunks it did spend are rejected rather than left pending.
    if (mine !== generation || held?.requestId !== requestId) {
      if (result.ok)
        for (const id of result.proposalIds) void proposalStore.settle(id, 'rejected', null)
      return
    }
    if (!result.ok) {
      set({
        detect: {
          ...held,
          // The author stopped it: back to the offer, with no complaint and nothing applied.
          status: result.code === 'CANCELLED' ? 'offer' : 'failed',
          requestId: null,
          progress: null,
          error:
            result.code === 'CANCELLED'
              ? null
              : { message: result.message, nextStep: result.nextStep }
        }
      })
      return
    }
    const current = get().draft
    if (current === null) return
    const { draft: merged, added, titled } = applyStructure(current, result.suggestions)
    // Undo does not cross the pass: its proposals are settled against the draft it produced.
    set({
      draft: merged,
      history: [],
      selected: [],
      anchor: null,
      detect: {
        ...held,
        status: 'done',
        requestId: null,
        progress: null,
        error: null,
        proposalIds: result.proposalIds,
        outcome: {
          costUsd: result.costUsd,
          model: result.model,
          chunks: result.chunks,
          added,
          titled
        }
      }
    })
  },

  cancelDetect() {
    const detect = get().detect
    if (detect?.status !== 'running' || detect.requestId === null) return
    // Main answers the request CANCELLED; the reply puts the offer back.
    void useAiActivityStore.getState().cancel(detect.requestId)
  },

  skipDetect() {
    set((s) => (s.detect?.status === 'offer' ? { detect: { ...s.detect, status: 'skipped' } } : {}))
  },

  rejectSuggestion(id) {
    const before = get().draft
    if (before === null || get().detect?.status === 'running') return
    edit((draft) => rejectSuggestion(draft, id))
    const after = get().draft
    if (after === before) return
    set((s) =>
      s.detect === null ? {} : { detect: { ...s.detect, rejected: s.detect.rejected + 1 } }
    )
  },

  async commit() {
    const { draft, busy, detect, target, projectName, projectFormat } = get()
    if (!draft || busy || detect?.status === 'running') return
    const mine = generation
    set({ busy: true })
    try {
      if (target === 'new') {
        const name = projectName.trim()
        if (name.length === 0) {
          toast.error('Give the project a name first.')
          set({ busy: false })
          return
        }
        const info = await useProjectStore.getState().createFromImport(draft, name, projectFormat)
        if (mine !== generation) return
        // The save dialog was cancelled: the review stays as it was and nothing was written.
        if (info === null) {
          set({ busy: false })
          return
        }
        toast.success(`Created "${info.name}" from ${draft.source.name}`)
        generation++
        set({ ...CLEARED })
        return
      }
      await flushPendingSaves()
      const { nodes, words, tree, rewritten } = await ipc().invoke('import:commit', { draft })
      if (mine !== generation) return
      const first = nodes.find((node) => node.kind === 'document') ?? null
      // Existing nodes may have moved, been renamed, or gone, so the index is rebuilt once from
      // main's tree rather than patched change by change.
      useTreeStore.setState((s) => {
        const index = buildIndex(tree)
        const collapsed = Object.fromEntries(
          Object.entries(s.collapsed).filter(([id]) => id in index.byId)
        )
        const kept = s.selectedId !== null && s.selectedId in index.byId ? s.selectedId : null
        return {
          ...index,
          collapsed: expandAncestors({ ...index, collapsed }, first?.parentId ?? null),
          selectedId: first ? first.id : kept
        }
      })
      // Existing scenes a merge or a split rewrote: their loaded copies are read again.
      if (rewritten.length > 0) {
        await refreshRewrittenDocuments(rewritten.map((id) => ({ id, wordCount: null })))
      }
      const scenes = nodes.filter((node) => node.kind === 'document').length
      toast.success(
        `Imported ${scenes} ${scenes === 1 ? 'scene' : 'scenes'} (${words.toLocaleString()} words)`
      )
      settleChunks(get().detect, true)
      generation++
      set({ ...CLEARED })
    } catch (err) {
      toast.error(describeError(err))
      if (mine === generation) set({ busy: false })
    }
  },

  cancel() {
    const detect = get().detect
    if (detect?.status === 'running' && detect.requestId !== null) {
      void useAiActivityStore.getState().cancel(detect.requestId)
    }
    settleChunks(detect, false)
    generation++
    set({ ...CLEARED })
  }
}))

/** Drops the draft, the progress subscription, and in-flight requests. For tests and project close. */
export function resetImportStore(): void {
  useImportStore.getState().cancel()
  useImportStore.setState({ target: 'project', projectName: '', projectFormat: 'novel' })
  unsubscribe?.()
  unsubscribe = null
  counter = 0
}
