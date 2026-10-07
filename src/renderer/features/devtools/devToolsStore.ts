import { create } from 'zustand'
import {
  DEV_AI_MAX,
  DEV_LOG_MAX,
  type DevAiRequest,
  type DevClearTarget,
  type DevLogEntry,
  type DevRequestText
} from '@shared/devtools'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of developer tools (2026-10-07, `plans/plan-devtools.md`). Main owns the
 * switch and both buffers; this store mirrors them (a snapshot on load and on every switch-on,
 * then the `devtools:logAdded` / `devtools:requestChanged` pushes) and owns only what is local:
 * whether the panel is open and which rows' text the author asked to see. Revealed text lives
 * here in memory and goes with the panel's state; it is never written anywhere.
 */
interface DevToolsStoreState {
  enabled: boolean
  /** The panel is showing. Only ever true while `enabled`. */
  open: boolean
  log: DevLogEntry[]
  requests: DevAiRequest[]
  /** Rows whose prompt and answer the author revealed; null while the text is on its way. */
  texts: Record<number, DevRequestText | null>
  /** The last failed action, shown in the panel or the Advanced tab. */
  error: string | null
  busy: boolean
  load: () => Promise<void>
  setEnabled: (on: boolean) => Promise<void>
  /** Loads the state once and listens for what main pushes; returns the unsubscribe. */
  subscribe: () => () => void
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  clear: (what: DevClearTarget) => Promise<void>
  revealText: (id: number) => Promise<void>
  hideText: (id: number) => void
  openChromium: () => Promise<void>
  /** Puts the plain-text diagnostics report on the clipboard; true when it got there. */
  copyReport: () => Promise<boolean>
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

const EMPTY = { log: [], requests: [], texts: {} }

export const useDevToolsStore = create<DevToolsStoreState>((set, get) => {
  const fail = (err: unknown): void => set({ error: describeError(err) })

  const refresh = async (): Promise<void> => {
    const mine = generation
    const snapshot = await ipc().invoke('devtools:snapshot', undefined)
    if (mine !== generation) return
    set({ enabled: snapshot.enabled, log: snapshot.log, requests: snapshot.requests })
  }

  const applyEnabled = (enabled: boolean): void => {
    if (enabled) {
      set({ enabled })
      void refresh().catch(fail)
    } else {
      set({ enabled, open: false, ...EMPTY })
    }
  }

  return {
    enabled: false,
    open: false,
    ...EMPTY,
    error: null,
    busy: false,

    load: async () => {
      const mine = generation
      try {
        const state = await ipc().invoke('devtools:getState', undefined)
        if (mine !== generation) return
        applyEnabled(state.enabled)
      } catch (err) {
        if (mine === generation) fail(err)
      }
    },

    setEnabled: async (on) => {
      const mine = generation
      set({ busy: true, error: null })
      try {
        const state = await ipc().invoke('devtools:setEnabled', { on })
        if (mine === generation) applyEnabled(state.enabled)
      } catch (err) {
        if (mine === generation) fail(err)
      } finally {
        if (mine === generation) set({ busy: false })
      }
    },

    subscribe: () => {
      const offChanged = ipc().on('devtools:changed', (state) => {
        if (state.enabled !== get().enabled) applyEnabled(state.enabled)
      })
      const offLog = ipc().on('devtools:logAdded', (entry) => {
        if (!get().enabled) return
        set((s) => ({ log: [...s.log, entry].slice(-DEV_LOG_MAX) }))
      })
      const offRequest = ipc().on('devtools:requestChanged', (row) => {
        if (!get().enabled) return
        set((s) => {
          const at = s.requests.findIndex((r) => r.id === row.id)
          if (at === -1) return { requests: [...s.requests, row].slice(-DEV_AI_MAX) }
          const requests = [...s.requests]
          requests[at] = row
          return { requests }
        })
      })
      void get().load()
      return () => {
        offChanged()
        offLog()
        offRequest()
      }
    },

    openPanel: () => {
      if (!get().enabled) return
      set({ open: true })
      void refresh().catch(fail)
    },
    closePanel: () => set({ open: false }),
    togglePanel: () => {
      if (get().open) get().closePanel()
      else get().openPanel()
    },

    clear: async (what) => {
      try {
        await ipc().invoke('devtools:clear', { what })
        set(what === 'log' ? { log: [] } : { requests: [], texts: {} })
      } catch (err) {
        fail(err)
      }
    },

    revealText: async (id) => {
      set((s) => ({ texts: { ...s.texts, [id]: null } }))
      try {
        const text = await ipc().invoke('devtools:requestText', { id })
        if (text === null) {
          get().hideText(id)
          toast.warning('That request’s text is no longer held.')
          return
        }
        if (id in get().texts) set((s) => ({ texts: { ...s.texts, [id]: text } }))
      } catch (err) {
        get().hideText(id)
        fail(err)
      }
    },

    hideText: (id) =>
      set((s) => {
        const texts = { ...s.texts }
        delete texts[id]
        return { texts }
      }),

    openChromium: async () => {
      try {
        await ipc().invoke('devtools:openChromium', undefined)
      } catch (err) {
        fail(err)
      }
    },

    copyReport: async () => {
      try {
        const report = await ipc().invoke('devtools:report', undefined)
        await navigator.clipboard.writeText(report)
        toast.success('Diagnostics copied to the clipboard.')
        return true
      } catch (err) {
        fail(err)
        return false
      }
    }
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetDevToolsStore(): void {
  generation++
  useDevToolsStore.setState({
    enabled: false,
    open: false,
    ...EMPTY,
    error: null,
    busy: false
  })
}
