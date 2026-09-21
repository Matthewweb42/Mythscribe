import { create } from 'zustand'
import type { UpdateChannel, UpdateState } from '@shared/updates'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { closeProjectWithConfirm } from '@renderer/features/shell/menuActions'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of the updates (F-15.7). Main owns the updater, the check timer, and
 * everything stored; this store holds the state main last answered (or pushed through
 * `updates:changed` when a background check found something) and the failure of the last action.
 * Errors land in `error` rather than a toast: the author is inside the Updates tab when they
 * happen, and the next step belongs beside the button.
 */
interface UpdateStoreState {
  /** null until the first `load` resolves. */
  state: UpdateState | null
  /** True while any of the update channels is in flight; the tab disables its buttons on it. */
  busy: boolean
  /** The message from the last failed action, cleared by the next one. */
  error: string | null
  load: () => Promise<void>
  /** Asks the release feed now; the answer is whatever the check left behind. */
  check: () => Promise<void>
  setChannel: (channel: UpdateChannel) => Promise<void>
  setAutoCheck: (on: boolean) => Promise<void>
  /** The author has read what is new in this version; it is not offered again. */
  markSeen: () => Promise<void>
  /**
   * Restarts into the downloaded update. The project is closed first through the same confirm
   * and flush path as File › Close project, because the installer starts before the app exits;
   * a refused confirm leaves everything as it was.
   */
  installNow: () => Promise<void>
  /** Loads the state once and listens for what main pushes; returns the unsubscribe. */
  subscribe: () => () => void
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useUpdateStore = create<UpdateStoreState>((set, get) => {
  const run = async (call: () => Promise<UpdateState>): Promise<void> => {
    const mine = generation
    set({ busy: true, error: null })
    try {
      const state = await call()
      if (mine !== generation) return
      set({ state })
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ error: describeError(err) })
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  return {
    state: null,
    busy: false,
    error: null,

    load: () => run(() => ipc().invoke('updates:getState', undefined)),

    check: () => run(() => ipc().invoke('updates:check', undefined)),

    setChannel: (channel) => run(() => ipc().invoke('updates:setChannel', { channel })),

    setAutoCheck: (on) => run(() => ipc().invoke('updates:setAutoCheck', { on })),

    markSeen: () => run(() => ipc().invoke('updates:markSeen', undefined)),

    installNow: async () => {
      if (useProjectStore.getState().current !== null) {
        const closed = await closeProjectWithConfirm()
        if (!closed) return
      }
      const mine = generation
      set({ busy: true, error: null })
      try {
        // Main quits the app from here, so nothing after this normally runs.
        await ipc().invoke('updates:install', undefined)
      } catch (err: unknown) {
        if (mine === generation) set({ error: describeError(err) })
      } finally {
        if (mine === generation) set({ busy: false })
      }
    },

    subscribe: () => {
      const off = ipc().on('updates:changed', (state) => {
        // Main moved on by itself (a background check, a finished download), so whatever went
        // wrong before describes a state that is gone.
        set({ state, error: null })
      })
      void get().load()
      return off
    }
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetUpdateStore(): void {
  generation++
  useUpdateStore.setState({ state: null, busy: false, error: null })
}
