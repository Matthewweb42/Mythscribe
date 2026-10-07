import { Check, Lock, X } from 'lucide-react'
import { EDIT_PASS_LABEL } from '@shared/editPass'
import { useEditPassStore, useSceneLocked } from './editPassStore'
import { useSceneChanges } from './useTrackedChanges'

const BUTTON =
  'flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * The strip above a scene's text for edit passes (F-14.15): while the scene is in a running pass,
 * that it is read-only and why, with Stop and the progress; otherwise, when the scene has pending
 * tracked changes, how many, with Accept all and Reject all for the scene. Each change also has
 * its own Accept and Reject inline in the text.
 */
export function TrackedChangesBar({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const locked = useSceneLocked(nodeId)
  const changes = useSceneChanges(nodeId).filter((change) => change.kind === 'change')
  const busy = useEditPassStore((s) => s.busy)

  if (locked !== null) {
    const done = locked.doneNodeIds.length
    return (
      <div
        role="status"
        data-testid="edit-pass-lock"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-fg-muted"
      >
        <Lock size={13} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {`${EDIT_PASS_LABEL[locked.type]} running (${done} of ${locked.nodeIds.length} scenes): this scene is read-only until the pass finishes.`}
        </span>
        <button
          type="button"
          className={BUTTON}
          onClick={() => useEditPassStore.getState().openWorkspace()}
        >
          Show progress
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => void useEditPassStore.getState().cancel(locked.id)}
        >
          Stop pass
        </button>
      </div>
    )
  }

  if (changes.length === 0) return null
  return (
    <div
      role="region"
      aria-label="Tracked changes"
      data-testid="tracked-changes-bar"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-fg-muted"
    >
      <span className="min-w-0 flex-1" data-testid="tracked-changes-count">
        {changes.length === 1
          ? '1 tracked change from an edit pass'
          : `${changes.length} tracked changes from edit passes`}
      </span>
      <button
        type="button"
        className={BUTTON}
        disabled={busy}
        onClick={() => void useEditPassStore.getState().accept(changes)}
      >
        <Check size={13} aria-hidden="true" />
        Accept all
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={busy}
        onClick={() => void useEditPassStore.getState().reject(changes)}
      >
        <X size={13} aria-hidden="true" />
        Reject all
      </button>
    </div>
  )
}
