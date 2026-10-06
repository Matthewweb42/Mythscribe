import { create } from 'zustand'
import { DEFAULT_MODELS } from '@shared/ai'
import { isFeatureAllowed, providerForSource } from '@shared/aiSettings'
import type { ImportDraft, ImportPlacement } from '@shared/import'
import {
  estimateStructureCost,
  flattenDraft,
  type ImportDetectProgress,
  type StructureEstimate
} from '@shared/importStructure'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useAiStore } from '@renderer/features/ai/aiStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { buildIndex, expandAncestors, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import {
  applyStructure,
  mergeScene,
  moveNode,
  moveScene,
  nestChapter,
  rejectSuggestion,
  renameNode,
  setExcluded,
  setPlacement,
  splitScene
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
 * it. Null while no pass is possible — the dial or the toggle is off (F-14.4), or the draft has
 * no words left to send.
 */
export interface DetectState {
  status: DetectStatus
  /** Words the pass would send: the draft's non-excluded ones, recomputed as the author excludes. */
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

/** The subscription to main's chunk progress; one for the renderer, opened by the first pass. */
let unsubscribe: (() => void) | null = null
let counter = 0
/** A request id `ai:cancel` can find (F-5.10), unique across this renderer's passes. */
const nextRequestId = (): string => `imp-${Date.now().toString(36)}-${++counter}`

/** The model the pass would run on: the fast tier of the provider this project's source sends through (F-15.4). */
function fastModel(): string {
  const source = useAiSettingsStore.getState().settings?.source ?? 'ownKey'
  const provider = providerForSource(source)
  return useAiStore.getState().status?.models[provider].fast ?? DEFAULT_MODELS.fast
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
 * draft, this store holds it while the author corrects it in the review dialog, and Import hands
 * the edited draft back in one call. Nothing is written until then — Cancel simply drops the
 * draft — and every edit goes through the pure functions in `draftEdits`, so the store owns only
 * *which* draft is under review, not how it changes. The AI pass (F-12.3) is one more thing that
 * can change the draft: it is offered with its cost before anything is sent, runs in main chunk
 * by chunk, and its suggestions are merged in by `applyStructure`; while it runs the draft is
 * frozen, because its indices are global over the draft it was given.
 */
interface ImportState {
  /** The draft under review, or null when no import is in progress. */
  draft: ImportDraft | null
  /** The scene whose paragraphs the dialog shows beside the tree (for splitting), if any. */
  sceneId: string | null
  /** True while main is reading the file or writing the draft; the dialog's buttons disable on it. */
  busy: boolean
  /** The node whose title is being edited inline in the dialog, if any. */
  renamingId: string | null
  /** The AI structure pass (F-12.3) for this draft, or null when it cannot be offered. */
  detect: DetectState | null
  /** Asks main for a draft (a `path` skips the native dialog, as `project:open` does). */
  open: (path?: string) => Promise<void>
  /** Shows a scene's paragraphs beside the tree, or clears the pane with null. */
  selectScene: (id: string | null) => void
  startRename: (id: string) => void
  endRename: () => void
  rename: (id: string, title: string) => void
  setExcluded: (id: string, excluded: boolean) => void
  setPlacement: (chapterId: string, placement: ImportPlacement) => void
  move: (id: string, by: -1 | 1) => void
  nest: (chapterId: string, to: 'prev' | 'next') => void
  moveScene: (sceneId: string, to: 'prev' | 'next') => void
  mergeScene: (sceneId: string) => void
  splitScene: (sceneId: string, paragraphIndex: number) => void
  /** Runs the AI pass and merges what it suggests into the draft. Ignored unless it is on offer. */
  startDetect: () => Promise<void>
  /** Stops a running pass; main answers CANCELLED and the draft stays as the heuristics left it. */
  cancelDetect: () => void
  /** Keeps the heuristic draft: the offer goes away and nothing is sent. */
  skipDetect: () => void
  /** Undoes one suggestion (a scene or chapter the pass added) and counts it against the proposal. */
  rejectSuggestion: (id: string) => void
  /** Writes the reviewed draft, merges the created rows into the tree, and selects the first one. */
  commit: () => Promise<void>
  /** Drops the draft; nothing was written. */
  cancel: () => void
}

/** Bumped by every cancel() and commit() so a response from a superseded import is dropped. */
let generation = 0

/**
 * Applies one pure edit to the draft under review; without a draft nothing happens, and neither
 * does anything while the AI pass runs — its suggestions are indices into the draft it was given.
 * The offer's estimate follows the edit, so excluding half the book halves the price shown.
 */
function edit(change: (draft: ImportDraft) => ImportDraft): void {
  useImportStore.setState((s) => {
    if (s.draft === null || s.detect?.status === 'running') return {}
    const draft = change(s.draft)
    if (draft === s.draft) return {}
    if (s.detect?.status !== 'offer') return { draft }
    return { draft, detect: { ...s.detect, ...estimateFor(draft) } }
  })
}

export const useImportStore = create<ImportState>((set, get) => ({
  draft: null,
  sceneId: null,
  busy: false,
  renamingId: null,
  detect: null,

  async open(path) {
    if (get().busy) return
    const mine = generation
    set({ busy: true })
    try {
      const draft = await ipc().invoke('import:open', path === undefined ? {} : { path })
      if (mine !== generation) return
      // Null is the native dialog cancelled: no draft, no message, nothing to undo.
      if (draft) set({ draft, sceneId: null, renamingId: null, detect: offerFor(draft) })
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

  setExcluded(id, excluded) {
    edit((draft) => setExcluded(draft, id, excluded))
  },

  setPlacement(chapterId, placement) {
    edit((draft) => setPlacement(draft, chapterId, placement))
  },

  move(id, by) {
    edit((draft) => moveNode(draft, id, by))
  },

  nest(chapterId, to) {
    edit((draft) => nestChapter(draft, chapterId, to))
  },

  moveScene(sceneId, to) {
    edit((draft) => moveScene(draft, sceneId, to))
  },

  mergeScene(sceneId) {
    // The merged scene is gone; the pane follows the scene that swallowed it.
    set((s) => (s.sceneId === sceneId ? { sceneId: null } : {}))
    edit((draft) => mergeScene(draft, sceneId))
  },

  splitScene(sceneId, paragraphIndex) {
    edit((draft) => splitScene(draft, sceneId, paragraphIndex))
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
    set({
      draft: merged,
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
    // The rejected scene is gone; the pane follows the scene that swallowed it.
    set((s) => (s.sceneId === id ? { sceneId: null } : {}))
    edit((draft) => rejectSuggestion(draft, id))
    const after = get().draft
    if (after === before) return
    set((s) =>
      s.detect === null ? {} : { detect: { ...s.detect, rejected: s.detect.rejected + 1 } }
    )
  },

  async commit() {
    const { draft, busy, detect } = get()
    if (!draft || busy || detect?.status === 'running') return
    const mine = generation
    set({ busy: true })
    try {
      const { nodes, words } = await ipc().invoke('import:commit', { draft })
      if (mine !== generation) return
      const first = nodes.find((node) => node.kind === 'document') ?? null
      useTreeStore.setState((tree) => {
        const index = buildIndex([...Object.values(tree.byId), ...nodes])
        return {
          ...index,
          collapsed: expandAncestors(
            { ...index, collapsed: tree.collapsed },
            first?.parentId ?? null
          ),
          selectedId: first ? first.id : tree.selectedId
        }
      })
      const scenes = nodes.filter((node) => node.kind === 'document').length
      toast.success(
        `Imported ${scenes} ${scenes === 1 ? 'scene' : 'scenes'} (${words.toLocaleString()} words)`
      )
      settleChunks(get().detect, true)
      generation++
      set({ draft: null, sceneId: null, renamingId: null, busy: false, detect: null })
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
    set({ draft: null, sceneId: null, renamingId: null, busy: false, detect: null })
  }
}))

/** Drops the draft, the progress subscription, and in-flight requests. For tests and project close. */
export function resetImportStore(): void {
  useImportStore.getState().cancel()
  unsubscribe?.()
  unsubscribe = null
  counter = 0
}
