import { create } from 'zustand'
import type { SettingsDialogTabId } from './settingsDialogTabs'

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
  /**
   * The Settings tab to open on when the caller named one (F-15.5: the low-credit notice opens
   * Account); null for the dialog's own first tab. Cleared with the dialog, so the next opener
   * starts fresh.
   */
  settingsTab: SettingsDialogTabId | null
  show: (id: ShellDialogId, tab?: SettingsDialogTabId) => void
  close: () => void
}

export const useShellDialogStore = create<ShellDialogState>((set) => ({
  open: null,
  settingsTab: null,
  show: (id, tab) => set({ open: id, settingsTab: tab ?? null }),
  close: () => set({ open: null, settingsTab: null })
}))

/** Closes whatever is open. For tests only. */
export function resetShellDialogStore(): void {
  useShellDialogStore.setState({ open: null, settingsTab: null })
}
