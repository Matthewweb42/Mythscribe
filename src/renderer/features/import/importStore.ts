import { create } from 'zustand'
import type { ImportDraft, ImportPlacement } from '@shared/import'
import { buildIndex, expandAncestors, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import {
  mergeScene,
  moveNode,
  moveScene,
  nestChapter,
  renameNode,
  setExcluded,
  setPlacement,
  splitScene
} from './draftEdits'

/**
 * Manuscript import (F-12.2), the renderer's half: main reads the file and answers a structure
 * draft, this store holds it while the author corrects it in the review dialog, and Import hands
 * the edited draft back in one call. Nothing is written until then — Cancel simply drops the
 * draft — and every edit goes through the pure functions in `draftEdits`, so the store owns only
 * *which* draft is under review, not how it changes.
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
  /** Writes the reviewed draft, merges the created rows into the tree, and selects the first one. */
  commit: () => Promise<void>
  /** Drops the draft; nothing was written. */
  cancel: () => void
}

/** Bumped by every cancel() and commit() so a response from a superseded import is dropped. */
let generation = 0

/** Applies one pure edit to the draft under review; without a draft nothing happens. */
function edit(change: (draft: ImportDraft) => ImportDraft): void {
  useImportStore.setState((s) => (s.draft === null ? {} : { draft: change(s.draft) }))
}

export const useImportStore = create<ImportState>((set, get) => ({
  draft: null,
  sceneId: null,
  busy: false,
  renamingId: null,

  async open(path) {
    if (get().busy) return
    const mine = generation
    set({ busy: true })
    try {
      const draft = await ipc().invoke('import:open', path === undefined ? {} : { path })
      if (mine !== generation) return
      // Null is the native dialog cancelled: no draft, no message, nothing to undo.
      if (draft) set({ draft, sceneId: null, renamingId: null })
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

  async commit() {
    const { draft, busy } = get()
    if (!draft || busy) return
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
      generation++
      set({ draft: null, sceneId: null, renamingId: null, busy: false })
    } catch (err) {
      toast.error(describeError(err))
      if (mine === generation) set({ busy: false })
    }
  },

  cancel() {
    generation++
    set({ draft: null, sceneId: null, renamingId: null, busy: false })
  }
}))

/** Drops the draft and invalidates in-flight requests. For tests and project close. */
export function resetImportStore(): void {
  useImportStore.getState().cancel()
}
