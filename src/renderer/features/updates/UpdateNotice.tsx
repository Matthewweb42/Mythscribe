import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useUpdateStore } from './updateStore'

/**
 * The header's update line (F-15.7): one quiet button when a downloaded update is waiting for a
 * restart, or when the app came back up on a new version whose notes have not been read. It
 * opens Settings on the Updates tab, where the notes and the install button are; it never
 * interrupts, and it renders nothing the rest of the time.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const state = useUpdateStore((s) => s.state)
  const show = useShellDialogStore((s) => s.show)

  const ready = state?.status.state === 'ready' ? state.status.version : null
  const label =
    ready !== null
      ? 'Update ready — restart to install'
      : state?.unseenNotes === true
        ? `What's new in ${state.currentVersion}`
        : null
  if (label === null) return null

  return (
    <button
      type="button"
      data-testid="update-notice"
      title="Open the Updates tab in Settings"
      onClick={() => show('settings', 'updates')}
      className="rounded-md border border-accent/40 px-2 py-0.5 text-xs text-accent hover:bg-surface-raised"
    >
      {label}
    </button>
  )
}
