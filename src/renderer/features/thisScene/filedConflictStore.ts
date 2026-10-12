import { create } from 'zustand'
import type { FiledConflict } from '@shared/filing'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { pageKey, usePageStore } from '@renderer/features/research/pageStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDismissedStore } from './dismissedStore'

/**
 * The filed-line conflicts of Needs a look (F-16.9; story memory v2): the one owner of the Pinned
 * lines whose Research source changed. Main finds them locally (`research:filedConflicts`); the
 * list is read on a v2 open, after a Research or Pinned page saves, and after a filing or its
 * undo. *Keep line* and *Update line* take a conflict off at once.
 */
interface FiledConflictState {
  conflicts: FiledConflict[]
  loaded: boolean
  load: () => Promise<void>
  /** *Keep line*: the line stays; the conflict joins Dismissed until the page changes again. */
  keep: (conflict: FiledConflict) => Promise<void>
  /** *Update line*: the author's own words for the line. Answers whether it was written. */
  update: (conflict: FiledConflict, text: string) => Promise<boolean>
  clear: () => void
}

let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** How long after a page save the list is read again (saves come in bursts). */
const REFRESH_DELAY_MS = 400

export const useFiledConflictStore = create<FiledConflictState>((set, get) => ({
  conflicts: [],
  loaded: false,

  async load() {
    const mine = generation
    const conflicts = await ipc().invoke('research:filedConflicts', undefined)
    if (mine === generation) set({ conflicts, loaded: true })
  },

  async keep(conflict) {
    const mine = generation
    try {
      const row = await ipc().invoke('research:keepFiledLine', { conflict })
      if (mine !== generation) return
      set({ conflicts: get().conflicts.filter((each) => each.key !== conflict.key) })
      useDismissedStore.getState().add(row)
    } catch (err) {
      toast.error(describeError(err))
    }
  },

  async update(conflict, text) {
    const mine = generation
    try {
      // The sheet's unsaved typing in that record's Pinned is written first.
      await flushPendingSaves()
      await ipc().invoke('research:updateFiledLine', {
        recordId: conflict.recordId,
        lineIndex: conflict.lineIndex,
        line: conflict.line,
        text
      })
      if (mine !== generation) return true
      set({ conflicts: get().conflicts.filter((each) => each.key !== conflict.key) })
      await usePageStore.getState().reload([pageKey({ kind: 'pinned', id: conflict.recordId })])
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    }
  },

  clear() {
    generation++
    if (timer !== null) clearTimeout(timer)
    timer = null
    set({ conflicts: [], loaded: false })
  }
}))

/**
 * Reads the conflicts again shortly (a Research or Pinned page was saved): only once the list
 * has been loaded for a v2 project, so a v1 project never asks.
 */
export function refreshFiledConflictsSoon(): void {
  if (!useFiledConflictStore.getState().loaded) return
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    useFiledConflictStore
      .getState()
      .load()
      .catch(() => undefined)
  }, REFRESH_DELAY_MS)
}

/** Empties the store and drops a pending refresh. For tests and project close. */
export function resetFiledConflictStore(): void {
  useFiledConflictStore.getState().clear()
}
