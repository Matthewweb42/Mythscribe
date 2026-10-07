import { create } from 'zustand'
import type { DockPanelId, DockTarget } from '@shared/dock'

/** The drag payload type; only a panel grip sets it, so text, tree rows, and cards are ignored. */
export const DOCK_DRAG_TYPE = 'application/x-mythscribe-panel'

/**
 * The panel being dragged by its grip and where it would land (layout 3c). Transient UI state, so
 * a small store of its own rather than the persisted layout.
 */
interface DockDragState {
  dragging: DockPanelId | null
  over: DockTarget | null
}

export const useDockDragStore = create<DockDragState>(() => ({ dragging: null, over: null }))

/** Ends any drag: after a drop or a cancelled drag, and in tests. */
export function resetDockDrag(): void {
  useDockDragStore.setState({ dragging: null, over: null })
}
