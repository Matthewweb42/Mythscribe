import { create } from 'zustand'
import type { ResearchDoc } from '@shared/research'
import type { Output } from '@shared/ipc/contract'
import { readDropped } from '@renderer/features/library/droppedFiles'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * The Research section's meta (F-16.8, story memory v2): the one owner of each Research
 * document's origin, original and Not canon switch, by node id. The documents themselves are
 * tree nodes (`treeStore`) and their text is the page store's. Loaded on a v2 open; every action
 * merges what main answers, never reloading the list.
 */
interface ResearchState {
  docs: Record<string, ResearchDoc>
  loaded: boolean
  load: () => Promise<void>
  /**
   * Uploads files into `parentId` (default the Research root) through the library's open dialog;
   * the new documents join the tree, the first is opened, and every skipped file is named in a
   * toast. Errors propagate.
   */
  add: (parentId?: string) => Promise<void>
  /**
   * Files dropped on the window (story memory v2's drop, never the Library's sort): uploaded into
   * the Research root as `add` does, and the Research tab is shown with the first one open.
   */
  addDropped: (files: readonly File[]) => Promise<void>
  /** A written note under `parentId` (default the root), after `afterId`; opened with inline rename. */
  create: (target?: { parentId: string; afterId?: string }) => Promise<void>
  /** Switches a whole page Not canon, or back. Errors propagate. */
  setNotCanon: (nodeId: string, notCanon: boolean) => Promise<void>
  /** Opens an upload's original in the OS's app. Errors propagate. */
  openOriginal: (nodeId: string) => Promise<void>
  /** F-16.9: the page was filed into Pinned at `filedAt` (main's answer to Apply). */
  setFiled: (nodeId: string, filedAt: string | null) => void
  clear: () => void
}

/**
 * The open project's turn: bumped by `clear` only, so an answer for a project that closed is
 * dropped. A `load` in flight never voids an upload's or a note's answer.
 */
let generation = 0

const merge = (
  docs: Record<string, ResearchDoc>,
  more: readonly ResearchDoc[]
): Record<string, ResearchDoc> => {
  const next = { ...docs }
  for (const doc of more) next[doc.nodeId] = doc
  return next
}

export const useResearchStore = create<ResearchState>((set, get) => {
  /** An upload's answer: the meta merged, the pages in the tree (the first opened), skips named. */
  const landed = (result: Output<'research:addData'>): void => {
    set({ docs: merge(get().docs, result.docs) })
    useTreeStore.getState().mergeCreated(result.nodes)
    for (const skipped of result.skipped) toast.error(`${skipped.name}: ${skipped.reason}`)
  }

  return {
    docs: {},
    loaded: false,

    async load() {
      const mine = generation
      const listed = await ipc().invoke('research:list', undefined)
      if (mine !== generation) return
      // What the store holds is at least as new as the list: every change it makes is merged as
      // main answers it, and the list may have been read before that answer. So the list only adds.
      const held = get().docs
      set({ docs: merge(merge({}, listed), Object.values(held)), loaded: true })
    },

    async add(parentId) {
      const mine = generation
      const result = await ipc().invoke('research:add', parentId === undefined ? {} : { parentId })
      if (result === null || mine !== generation) return
      landed(result)
    },

    async addDropped(dropped) {
      const mine = generation
      const files = await readDropped(dropped)
      if (files.length === 0) return
      const result = await ipc().invoke('research:addData', { files })
      if (mine !== generation) return
      if (result.nodes.length > 0) useLayoutStore.getState().setSidebarTab('research')
      landed(result)
    },

    async create(target) {
      const mine = generation
      const result = await ipc().invoke('research:create', target ?? {})
      if (mine !== generation) return
      set({ docs: merge(get().docs, [result.doc]) })
      useTreeStore.getState().mergeCreated([result.node], { rename: true })
    },

    async setNotCanon(nodeId, notCanon) {
      const mine = generation
      const doc = await ipc().invoke('research:setNotCanon', { nodeId, notCanon })
      if (mine !== generation) return
      set({ docs: merge(get().docs, [doc]) })
    },

    async openOriginal(nodeId) {
      await ipc().invoke('research:openOriginal', { nodeId })
    },

    setFiled(nodeId, filedAt) {
      const doc = get().docs[nodeId]
      if (doc !== undefined) set({ docs: merge(get().docs, [{ ...doc, filedAt }]) })
    },

    clear() {
      generation++
      set({ docs: {}, loaded: false })
    }
  }
})

/** Empties the store and drops any answer in flight. For tests and project close. */
export function resetResearchStore(): void {
  useResearchStore.getState().clear()
}
