import { create } from 'zustand'
import { DRAFT_NAME_MAX, type DraftChange, type DraftInfo, type DraftList } from '@shared/drafts'
import { refreshRewrittenDocuments } from '@renderer/features/editor/rewrittenDocuments'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the open project's drafts in the renderer (F-8.5): main's list (oldest
 * first, one active) and the actions on it. Every action awaits main and keeps the list it
 * answers; nothing is optimistic. A switch or a revert rewrites live document text in main, so
 * pending saves are flushed first (otherwise an editor's next autosave would put the old text
 * back) and the rewritten documents are refreshed afterwards through the same path as crash
 * recovery. A failure toasts its cause and leaves the list as it was. Loaded when a project
 * opens and cleared when it closes (`App.tsx`).
 */
interface DraftState {
  /** The drafts in list order; null until `load` resolves. */
  drafts: DraftInfo[] | null
  activeId: string | null
  /** True while a mutating action is in flight; the dialog disables its actions meanwhile. */
  busy: boolean
  load: () => Promise<void>
  /** Makes `id` the active draft; answers whether main did it (false after a toast). */
  switchTo: (id: string) => Promise<boolean>
  /** Copies draft `id` into a new, inactive draft named `name`; answers whether main did it. */
  duplicate: (id: string, name: string) => Promise<boolean>
  rename: (id: string, name: string) => Promise<boolean>
  /** Deletes an inactive draft; answers whether main did it. */
  remove: (id: string) => Promise<boolean>
  /**
   * Takes documents of the active draft back to draft `fromId`'s text: `nodeIds`, or every
   * manuscript document when omitted. Answers whether main did it.
   */
  revert: (fromId: string, nodeIds?: string[]) => Promise<boolean>
  /** Empties the store and drops any answer still on its way. */
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0

const listed = (list: DraftList): Pick<DraftState, 'drafts' | 'activeId'> => ({
  drafts: list.drafts,
  activeId: list.activeId
})

export const useDraftStore = create<DraftState>((set, get) => {
  /**
   * Runs one mutating action: flushes pending saves, asks main, keeps its list, and for a switch
   * or a revert refreshes the documents main rewrote. Answers false after a toast.
   */
  const mutate = async (
    ask: () => Promise<DraftList | DraftChange>,
    done?: () => string
  ): Promise<boolean> => {
    if (get().busy) return false
    const mine = generation
    set({ busy: true })
    try {
      await flushPendingSaves()
      const answer = await ask()
      if (mine !== generation) return false // the project closed meanwhile
      if ('changed' in answer) {
        set(listed(answer.list))
        await refreshRewrittenDocuments(answer.changed, { countsAsWriting: false })
      } else {
        set(listed(answer))
      }
      if (done) toast.success(done())
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  const nameOf = (id: string): string => get().drafts?.find((d) => d.id === id)?.name ?? 'draft'

  return {
    drafts: null,
    activeId: null,
    busy: false,

    async load() {
      const mine = ++generation
      const list = await ipc().invoke('drafts:list', undefined)
      if (mine !== generation) return
      set(listed(list))
    },

    switchTo(id) {
      if (id === get().activeId) return Promise.resolve(true)
      return mutate(
        () => ipc().invoke('drafts:switch', { id }),
        () => `Switched to "${nameOf(id)}".`
      )
    },

    duplicate(id, name) {
      return mutate(
        () => ipc().invoke('drafts:duplicate', { id, name }),
        () => `Created "${name.trim()}".`
      )
    },

    rename(id, name) {
      return mutate(() => ipc().invoke('drafts:rename', { id, name }))
    },

    remove(id) {
      const name = nameOf(id)
      return mutate(
        () => ipc().invoke('drafts:delete', { id }),
        () => `Deleted "${name}".`
      )
    },

    revert(fromId, nodeIds) {
      const name = nameOf(fromId)
      return mutate(
        () => ipc().invoke('drafts:revert', nodeIds ? { fromId, nodeIds } : { fromId }),
        () =>
          nodeIds?.length === 1 ? `Reverted the scene to "${name}".` : `Reverted to "${name}".`
      )
    },

    clear() {
      generation++
      set({ drafts: null, activeId: null, busy: false })
    }
  }
})

/** The active draft, or null before the list has loaded. */
export function activeDraftOf(state: Pick<DraftState, 'drafts' | 'activeId'>): DraftInfo | null {
  return state.drafts?.find((d) => d.id === state.activeId) ?? null
}

/**
 * Why `name` cannot name a draft, or null when it can: empty, too long, or (case-insensitively)
 * the name of another draft than `exceptId`. Main checks the same; this answers inside the prompt.
 */
export function draftNameProblem(
  name: string,
  drafts: readonly DraftInfo[],
  exceptId?: string
): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (trimmed.length > DRAFT_NAME_MAX) return `At most ${DRAFT_NAME_MAX} characters.`
  const key = trimmed.toLocaleLowerCase()
  if (drafts.some((d) => d.id !== exceptId && d.name.trim().toLocaleLowerCase() === key)) {
    return 'Another draft already has this name.'
  }
  return null
}

/** The name a duplicate is offered: "Draft N+1" for N drafts, counting on past any name taken. */
export function nextDraftName(drafts: readonly DraftInfo[]): string {
  for (let n = drafts.length + 1; ; n++) {
    const name = `Draft ${n}`
    if (draftNameProblem(name, drafts) === null) return name
  }
}

/** Empties the store and drops any answer in flight. For tests only. */
export function resetDraftStore(): void {
  useDraftStore.getState().clear()
}
