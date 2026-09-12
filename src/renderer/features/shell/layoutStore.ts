import { create } from 'zustand'
import {
  clampForEditorMin,
  clampTagBarHeight,
  defaultLayout,
  type Layout,
  type LayoutPanel
} from '@shared/layout'
import type { SidebarTabId } from '@shared/sidebarTabs'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long after the last change the debounced `layout:set` fires (F-7.2). */
export const LAYOUT_SAVE_DELAY_MS = 150

/**
 * The one owner of the panel layout (F-7.2): which panels are open and how wide each is, as
 * fractions of the window. Changes apply at once (the panels follow the drag live) and persist
 * after a short debounce, so a drag writes once, not per pointer move. A failed write reverts to
 * the last persisted value and toasts. Like `editor/settingsStore.ts`, the debounce timer and the
 * "value before the pending write" live at module level so no unmount can orphan a write; the
 * pending-save registry flushes it before a project closes or the window shuts. The layout is
 * app-wide, not per project, so `load()` runs once at app start and there is no per-project clear.
 */
interface LayoutState {
  /** The defaults until `load` resolves, so the shell can render before app-state.json is read. */
  layout: Layout
  load: () => Promise<void>
  /**
   * Sets a panel's size (a fraction of the window), clamped to the panel's limits and so the
   * editor keeps its minimum share next to the other open panels, then schedules the write.
   */
  setSize: (panel: LayoutPanel, size: number) => void
  /** Opens or closes a panel; a panel opening gives way first if the editor would get too little. */
  toggle: (panel: LayoutPanel) => void
  /** Shows a sidebar tab (F-7.3); a no-op for the tab already shown, so no write is scheduled. */
  setSidebarTab: (tab: SidebarTabId) => void
  /** Collapses or expands the document tag bar (F-4.4); its height is kept either way. */
  toggleTagBar: () => void
  /**
   * Sets the tag bar's height in px (F-4.4), clamped to its floor and to 60 % of the current
   * window height, then schedules the write; a no-op when the clamp lands on the current value.
   */
  setTagBarHeight: (height: number) => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: Layout | null = null
/** Bumped by every load() and reset so a response from a superseded request is dropped. */
let generation = 0
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** Writes the current layout now. The revert baseline survives a failure of a later write. */
async function write(): Promise<void> {
  cancelTimer()
  const value = useLayoutStore.getState().layout
  const revertTo = persisted
  persisted = null
  if (revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('layout:set', value)
  } catch (err) {
    if (mine !== generation) return // the store was reset meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useLayoutStore.setState({ layout: revertTo })
    throw err
  }
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

/** Writes a pending change at once, or nothing when the store is in sync. Used by the pending-save registry. */
async function flush(): Promise<void> {
  if (persisted === null) return
  await write()
}

function schedule(next: Layout, base: Layout): void {
  persisted ??= base
  useLayoutStore.setState({ layout: next })
  cancelTimer()
  timer = setTimeout(() => {
    write().catch(reportFailure)
  }, LAYOUT_SAVE_DELAY_MS)
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layout: defaultLayout(),

  async load() {
    unregister ??= registerPendingSave(flush)
    const mine = ++generation
    const value = await ipc().invoke('layout:get', undefined)
    if (mine !== generation) return
    // A change made while loading is already on its way to disk; it wins over the stored value.
    if (persisted !== null) return
    set({ layout: value })
  },

  setSize(panel, size) {
    const base = get().layout
    const clamped = clampForEditorMin(base, panel, size)
    if (clamped === base[panel].size) return
    schedule({ ...base, [panel]: { ...base[panel], size: clamped } }, base)
  },

  toggle(panel) {
    const base = get().layout
    const current = base[panel]
    const size = current.open ? current.size : clampForEditorMin(base, panel, current.size)
    schedule({ ...base, [panel]: { ...current, open: !current.open, size } }, base)
  },

  setSidebarTab(tab) {
    const base = get().layout
    if (base.sidebar.tab === tab) return
    schedule({ ...base, sidebar: { ...base.sidebar, tab } }, base)
  },

  toggleTagBar() {
    const base = get().layout
    schedule({ ...base, tagBar: { ...base.tagBar, open: !base.tagBar.open } }, base)
  },

  setTagBarHeight(height) {
    const base = get().layout
    const clamped = clampTagBarHeight(height, window.innerHeight)
    if (clamped === base.tagBar.height) return
    schedule({ ...base, tagBar: { ...base.tagBar, height: clamped } }, base)
  }
}))

/** The current layout; components read the panel they render from it. */
export function useLayout(): Layout {
  return useLayoutStore((s) => s.layout)
}

/**
 * Applies a drag or key step from a `ResizeHandle`: the px delta becomes a fraction of the
 * window and is added to the panel's current size. The one place px turn into fractions.
 */
export function resizePanelBy(panel: LayoutPanel, deltaPx: number): void {
  const state = useLayoutStore.getState()
  state.setSize(panel, state.layout[panel].size + deltaPx / window.innerWidth)
}

/** Applies a drag or key step from the tag bar's `ResizeHandle` (F-4.4): the px delta is added to its height. */
export function resizeTagBarBy(deltaPx: number): void {
  const state = useLayoutStore.getState()
  state.setTagBarHeight(state.layout.tagBar.height + deltaPx)
}

/** Drops the timer, the revert baseline, and the registration, then restores the defaults. For tests only. */
export function resetLayoutStore(): void {
  generation++
  cancelTimer()
  persisted = null
  unregister?.()
  unregister = null
  useLayoutStore.setState({ layout: defaultLayout() })
}
