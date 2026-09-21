import { create } from 'zustand'
import type { DiagnosticsState } from '@shared/diagnostics'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of diagnostics (F-15.8). Main owns the switch, what has been recorded, and
 * when a report leaves; this store holds the state main last answered (or pushed through
 * `diagnostics:changed` after a flush), so the Diagnostics tab reads the same bytes main would
 * send. A failed call lands in `error` rather than a toast: the author is inside the tab when it
 * happens, and the next step belongs beside the switch.
 */
interface DiagnosticsStoreState {
  /** null until the first `load` resolves. */
  state: DiagnosticsState | null
  /** True while a diagnostics channel is in flight; the tab disables the switch on it. */
  busy: boolean
  /** The message from the last failed action, cleared by the next one. */
  error: string | null
  load: () => Promise<void>
  /** Turns diagnostics on or off; off throws away everything recorded so far. */
  setEnabled: (on: boolean) => Promise<void>
  /** Loads the state once and listens for what main pushes; returns the unsubscribe. */
  subscribe: () => () => void
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useDiagnosticsStore = create<DiagnosticsStoreState>((set, get) => {
  const run = async (call: () => Promise<DiagnosticsState>): Promise<void> => {
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

    load: () => run(() => ipc().invoke('diagnostics:getState', undefined)),

    setEnabled: (on) => run(() => ipc().invoke('diagnostics:setEnabled', { on })),

    subscribe: () => {
      const off = ipc().on('diagnostics:changed', (state) => {
        // Main moved on by itself (a report was sent), so whatever went wrong before describes a
        // state that is gone.
        set({ state, error: null })
      })
      void get().load()
      return off
    }
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetDiagnosticsStore(): void {
  generation++
  useDiagnosticsStore.setState({ state: null, busy: false, error: null })
}
