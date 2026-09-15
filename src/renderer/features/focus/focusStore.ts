import { create } from 'zustand'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * Focus mode (F-6.1): OS fullscreen plus hidden chrome. `active` is the window's real
 * fullscreen state, never a wish: `enter`, `exit`, and `toggle` ask main and take the state it
 * answers, and `subscribe` mirrors `window:fullScreenChanged` for the cases nobody asked the
 * app for (the window manager or the OS leaving fullscreen on its own). A refused call toasts
 * and leaves `active` as it was. Not persisted: a reopened app starts windowed.
 */
interface FocusState {
  active: boolean
  enter: () => Promise<void>
  exit: () => Promise<void>
  toggle: () => Promise<void>
  /** Starts mirroring the window's fullscreen events; called once by `App`. Returns the unsubscribe. */
  subscribe: () => () => void
}

let unsubscribe: (() => void) | null = null

async function request(on: boolean): Promise<void> {
  try {
    const result = await ipc().invoke('window:setFullScreen', { on })
    useFocusStore.setState({ active: result.on })
  } catch (err) {
    toast.error(describeError(err))
  }
}

export const useFocusStore = create<FocusState>((_set, get) => ({
  active: false,
  enter: () => request(true),
  exit: () => request(false),
  toggle: () => request(!get().active),

  subscribe() {
    unsubscribe ??= ipc().on('window:fullScreenChanged', ({ on }) => {
      useFocusStore.setState({ active: on })
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
  useFocusStore.setState({ active: false })
}
