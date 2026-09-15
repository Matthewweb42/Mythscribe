import { create } from 'zustand'

/** The app-level dialogs the menu opens (F-7.1): Settings (F-7.5), the shortcuts reference (F-7.7), About. */
export const SHELL_DIALOG_IDS = ['settings', 'shortcuts', 'about'] as const
export type ShellDialogId = (typeof SHELL_DIALOG_IDS)[number]

/**
 * Which shell dialog is open, if any: one at a time, opened from the header button, the
 * Ctrl+, listener, the in-app bar, or a native menu click, all through `show`, and rendered
 * by `ShellDialogs` in `App`. A store rather than component state so the native menu (which
 * arrives as an event) and focus mode (where the header is unmounted) can open them too.
 */
interface ShellDialogState {
  open: ShellDialogId | null
  show: (id: ShellDialogId) => void
  close: () => void
}

export const useShellDialogStore = create<ShellDialogState>((set) => ({
  open: null,
  show: (id) => set({ open: id }),
  close: () => set({ open: null })
}))

/** Closes whatever is open. For tests only. */
export function resetShellDialogStore(): void {
  useShellDialogStore.setState({ open: null })
}
