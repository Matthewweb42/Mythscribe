import { create } from 'zustand'
import {
  defaultDock,
  movePanel as moveInDock,
  sameDock,
  stepPanel as stepInDock,
  type DockPanelId,
  type DockTarget
} from '@shared/dock'
import {
  clampForEditorMin,
  clampRect,
  columnWidth,
  defaultLayout,
  normalizeLayout,
  rectEquals,
  withColumnSize,
  type FloatingPanel,
  type Layout,
  type LayoutPanel,
  type Rect
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
   * Sets the width of a panel's column (a fraction of the window), clamped to the column's limits
   * and so the editor keeps its minimum share next to the other columns, then schedules the
   * write. Every panel stacked in the column takes the width (layout 3c).
   */
  setSize: (panel: LayoutPanel, size: number) => void
  /**
   * Opens or closes a panel; a panel opening gives way first if the editor would get too little,
   * and when even its floor is too much beside two wide panels (F-5.4 made three possible) the
   * others give way in `normalizeLayout`'s order (closing as a last resort, never the panel
   * being opened), so main never refuses the write.
   */
  toggle: (panel: LayoutPanel) => void
  /**
   * Moves a panel to a drop target (layout 3c): a new column beside another panel, or stacked
   * into its column. A move that changes nothing schedules no write; one that leaves the editor
   * too little makes the others give way, the moved panel last.
   */
  movePanel: (panel: DockPanelId, target: DockTarget) => void
  /** Move left / Move right from a panel's menu (`stepPanel` in `@shared/dock`). */
  stepPanel: (panel: DockPanelId, direction: 'left' | 'right') => void
  /** View › Reset layout: the default columns, open panels, and widths; the sidebar tab and the floating windows stay. */
  resetLayout: () => void
  /** Shows a sidebar tab (F-7.3); a no-op for the tab already shown, so no write is scheduled. */
  setSidebarTab: (tab: SidebarTabId) => void
  /**
   * Sets a floating window's geometry in px (F-6.6), clamped into the current window with
   * `clampRect`, then schedules the write; a no-op when the clamp lands on the current rect
   * (so the window can re-clamp itself on every resize without writing).
   */
  setFloatingRect: (panel: FloatingPanel, rect: Rect) => void
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
    const column = base.dock.columns.find((c) => c.includes(panel)) ?? [panel]
    if (clamped === columnWidth(base, column) && clamped === base[panel].size) return
    schedule(withColumnSize(base, panel, clamped), base)
  },

  toggle(panel) {
    const base = get().layout
    const current = base[panel]
    if (current.open) {
      schedule(normalizeLayout({ ...base, [panel]: { ...current, open: false } }, panel), base)
      return
    }
    // A panel opening into a column that is already showing takes the column's width; one
    // opening alone keeps its own, given way if the editor would get too little.
    const column = base.dock.columns.find((c) => c.includes(panel)) ?? [panel]
    const shown = columnWidth(base, column)
    const size = clampForEditorMin(base, panel, shown > 0 ? shown : current.size)
    const opened = withColumnSize({ ...base, [panel]: { ...current, open: true } }, panel, size)
    schedule(normalizeLayout(opened, panel), base)
  },

  movePanel(panel, target) {
    const base = get().layout
    const columns = moveInDock(base.dock.columns, panel, target)
    if (columns === base.dock.columns) return
    placeDock(base, columns, panel)
  },

  stepPanel(panel, direction) {
    const base = get().layout
    const columns = stepInDock(base.dock.columns, panel, direction, (column) =>
      isColumnShown(base, column)
    )
    if (sameDock(columns, base.dock.columns)) return
    placeDock(base, columns, panel)
  },

  resetLayout() {
    const base = get().layout
    const fresh = defaultLayout()
    const next: Layout = {
      ...fresh,
      sidebar: { ...fresh.sidebar, tab: base.sidebar.tab },
      floating: base.floating,
      dock: { columns: defaultDock() }
    }
    schedule(next, base)
  },

  setSidebarTab(tab) {
    const base = get().layout
    if (base.sidebar.tab === tab) return
    schedule({ ...base, sidebar: { ...base.sidebar, tab } }, base)
  },

  setFloatingRect(panel, rect) {
    const base = get().layout
    const clamped = clampRect(rect, { width: window.innerWidth, height: window.innerHeight })
    if (rectEquals(clamped, base.floating[panel])) return
    schedule({ ...base, floating: { ...base.floating, [panel]: clamped } }, base)
  }
}))

/** True when a column shows on screen: it holds the editor or an open panel. */
export function isColumnShown(layout: Layout, column: readonly DockPanelId[]): boolean {
  return column.some((id) => id === 'editor' || layout[id].open)
}

/**
 * Applies a new arrangement: a side panel that joined a showing column takes that column's
 * width, then the editor minimum is restored with the moved panel kept open.
 */
function placeDock(base: Layout, columns: DockPanelId[][], panel: DockPanelId): void {
  let next: Layout = { ...base, dock: { columns } }
  if (panel !== 'editor') {
    const column = columns.find((c) => c.includes(panel)) ?? [panel]
    const others = column.filter((id) => id !== panel)
    const shown = columnWidth(next, others)
    if (shown > 0) next = withColumnSize(next, panel, shown)
    next = normalizeLayout(next, panel)
  } else {
    next = normalizeLayout(next)
  }
  schedule(next, base)
}

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
  const column = state.layout.dock.columns.find((c) => c.includes(panel)) ?? [panel]
  const width = columnWidth(state.layout, column) || state.layout[panel].size
  state.setSize(panel, width + deltaPx / window.innerWidth)
}

/** Applies a drag or key step on a floating window's title bar (F-6.6): the px deltas move it. */
export function moveFloatingBy(panel: FloatingPanel, dxPx: number, dyPx: number): void {
  const state = useLayoutStore.getState()
  const rect = state.layout.floating[panel]
  state.setFloatingRect(panel, { ...rect, x: rect.x + dxPx, y: rect.y + dyPx })
}

/** Applies a Shift+arrow step on a floating window's title bar (F-6.6): the px deltas grow it. */
export function resizeFloatingBy(panel: FloatingPanel, dwPx: number, dhPx: number): void {
  const state = useLayoutStore.getState()
  const rect = state.layout.floating[panel]
  state.setFloatingRect(panel, { ...rect, width: rect.width + dwPx, height: rect.height + dhPx })
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
