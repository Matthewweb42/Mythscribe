import { create } from 'zustand'
import type { GoalsPatch, GoalsStatus } from '@shared/goals'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long after the last save the status is asked for again, so a burst of saves asks once. */
export const GOALS_REFRESH_MS = 400

/**
 * The one owner of the writing goals in the renderer (F-10.3): main's `GoalsStatus` (the
 * targets and where the author stands), loaded when a project opens and refreshed shortly after
 * every editor save (`refreshSoon`, from the document store's `onSaved`). `set` writes a patch
 * and takes main's answer; nothing is optimistic, since every figure is main's. `open` is the
 * Goals dialog's flag: the dialog is part of the project screen, opened from Tools › Goals… and
 * the status strip.
 */
interface GoalsState {
  status: GoalsStatus | null
  open: boolean
  load: () => Promise<void>
  clear: () => void
  /** Writes `patch`; answers whether it was stored (a refusal toasts its cause). */
  set: (patch: GoalsPatch) => Promise<boolean>
  /** Asks for the status again after `GOALS_REFRESH_MS`; later calls restart the wait. */
  refreshSoon: () => void
  show: () => void
  close: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

function cancelRefresh(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
  status: null,
  open: false,

  async load() {
    cancelRefresh()
    const mine = ++generation
    const status = await ipc().invoke('goals:get', undefined)
    if (mine !== generation) return // cleared or reloaded while this request was in flight
    set({ status })
  },

  clear() {
    generation++
    cancelRefresh()
    set({ status: null, open: false })
  },

  async set(patch) {
    const mine = generation
    try {
      const status = await ipc().invoke('goals:set', patch)
      if (mine === generation) set({ status })
      return true
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
      return false
    }
  },

  refreshSoon() {
    if (get().status === null) return // no project, or it has not loaded yet
    cancelRefresh()
    timer = setTimeout(() => {
      timer = null
      get()
        .load()
        .catch((err: unknown) => toast.error(describeError(err)))
    }, GOALS_REFRESH_MS)
  },

  show() {
    set({ open: true })
  },

  close() {
    set({ open: false })
  }
}))

/** Empties the store, drops a pending refresh, and invalidates in-flight requests. For tests only. */
export function resetGoalsStore(): void {
  useGoalsStore.getState().clear()
}
