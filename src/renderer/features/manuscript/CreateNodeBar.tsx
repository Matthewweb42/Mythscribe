import { useShallow } from 'zustand/react/shallow'
import type { NovelFormat } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, levelLabel, type HierarchyLevel } from '@shared/labels'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { resolveCreateTarget } from './placement'
import { useTreeStore } from './treeStore'

const BUTTON =
  'flex-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * The create buttons under the tree (F-2.2): one per hierarchy level, placed relative to the
 * selection. A button disables when there is nowhere valid to put that level (outside the
 * manuscript, or a missing intermediate level) or while a request is in flight.
 */
export function CreateNodeBar({ format }: { format: NovelFormat }): React.JSX.Element {
  const busy = useTreeStore((s) => s.busy)
  const createLevel = useTreeStore((s) => s.createLevel)
  const enabled = useTreeStore(
    useShallow((s) =>
      HIERARCHY_LEVELS.map((level) => resolveCreateTarget(s, s.selectedId, level) !== null)
    )
  )

  const onCreate = async (level: HierarchyLevel): Promise<void> => {
    try {
      await createLevel(level)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  return (
    <div className="flex shrink-0 gap-1 border-t border-line p-2">
      {[...HIERARCHY_LEVELS].reverse().map((level) => (
        <button
          key={level}
          type="button"
          disabled={busy || !enabled[HIERARCHY_LEVELS.indexOf(level)]}
          onClick={() => void onCreate(level)}
          className={BUTTON}
        >
          New {levelLabel(format, level).toLowerCase()}
        </button>
      ))}
    </div>
  )
}
