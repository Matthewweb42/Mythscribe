import { create } from 'zustand'

/**
 * Whether the welcome screen shows the create wizard (F-1.2) instead of its buttons. A store,
 * not component state, so File › New project (F-7.1) can open the wizard from the menu; the
 * welcome screen puts it back when it unmounts, so a reopened welcome screen starts on the
 * buttons.
 */
interface WelcomeState {
  creating: boolean
  setCreating: (creating: boolean) => void
}

export const useWelcomeStore = create<WelcomeState>((set) => ({
  creating: false,
  setCreating: (creating) => set({ creating })
}))

/** Back to the buttons. For tests only. */
export function resetWelcomeStore(): void {
  useWelcomeStore.setState({ creating: false })
}
