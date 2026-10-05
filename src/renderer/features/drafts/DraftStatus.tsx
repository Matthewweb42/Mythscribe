import { Layers } from 'lucide-react'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { activeDraftOf, useDraftStore } from './draftStore'

/**
 * The active draft's name in the status bar (F-8.5), so the author always knows which version of
 * the text is being edited. Shown only once the project has more than one draft; a click opens
 * the Drafts dialog.
 */
export function DraftStatus(): React.JSX.Element | null {
  const active = useDraftStore((s) => ((s.drafts?.length ?? 0) > 1 ? activeDraftOf(s) : null))
  const show = useShellDialogStore((s) => s.show)
  if (!active) return null
  return (
    <button
      type="button"
      onClick={() => show('drafts')}
      data-testid="status-draft"
      title="Drafts…"
      className="flex items-center gap-1 rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
    >
      <Layers size={12} aria-hidden="true" />
      {active.name}
    </button>
  )
}
