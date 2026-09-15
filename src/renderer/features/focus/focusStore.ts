import { create } from 'zustand'
import type { FloatingPanel } from '@shared/layout'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** The side panels the control bar (F-6.5) can show in focus mode; they float there (F-6.6). */
export type FocusPanel = FloatingPanel

/** Which side panels are shown in focus mode; session state, both closed on entry. */
export type FocusPanels = Record<FocusPanel, boolean>

const closedPanels = (): FocusPanels => ({ notes: false, assistant: false })

/**
 * Focus mode (F-6.1): OS fullscreen plus hidden chrome. `active` is the window's real
 * fullscreen state, never a wish: `enter`, `exit`, and `toggle` ask main and take the state it
 * answers, and `subscribe` mirrors `window:fullScreenChanged` for the cases nobody asked the
 * app for (the window manager or the OS leaving fullscreen on its own). A refused call toasts
 * and leaves `active` as it was. Not persisted: a reopened app starts windowed. F-6.5: the
 * notes and assistant panels have their own flags here for focus mode, so the persisted
 * layout (which governs the normal screen) is never touched; leaving focus mode closes both,
 * so every entry starts with the editor alone.
 */
interface FocusState {
  active: boolean
  panels: FocusPanels
  enter: () => Promise<void>
  exit: () => Promise<void>
  toggle: () => Promise<void>
  /** Shows or hides a side panel in focus mode (F-6.5). */
  togglePanel: (panel: FocusPanel) => void
  /** Starts mirroring the window's fullscreen events; called once by `App`. Returns the unsubscribe. */
  subscribe: () => () => void
}

let unsubscribe: (() => void) | null = null

/** Applies the window's fullscreen state; leaving focus mode closes the focus-mode panels. */
function applyActive(on: boolean): void {
  useFocusStore.setState(on ? { active: true } : { active: false, panels: closedPanels() })
}

async function request(on: boolean): Promise<void> {
  try {
    const result = await ipc().invoke('window:setFullScreen', { on })
    applyActive(result.on)
  } catch (err) {
    toast.error(describeError(err))
  }
}

export const useFocusStore = create<FocusState>((set, get) => ({
  active: false,
  panels: closedPanels(),
  enter: () => request(true),
  exit: () => request(false),
  toggle: () => request(!get().active),

  togglePanel(panel) {
    set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } }))
  },

  subscribe() {
    unsubscribe ??= ipc().on('window:fullScreenChanged', ({ on }) => {
      applyActive(on)
    })
    return () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}))

/**
 * Escape's share of focus mode: leaves it when active and answers whether the key was used, so
 * the editor's keymap and the document listener can both chain on it (F-6.1).
 */
export function escapeFocusMode(): boolean {
  const store = useFocusStore.getState()
  if (!store.active) return false
  void store.exit()
  return true
}

/** Drops the event subscription and leaves focus mode. For tests only. */
export function resetFocusStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useFocusStore.setState({ active: false, panels: closedPanels() })
}
