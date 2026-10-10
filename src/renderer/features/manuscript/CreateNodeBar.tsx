import { useShallow } from 'zustand/react/shallow'
import { Plus } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { HIERARCHY_LEVELS, levelLabel, type HierarchyLevel } from '@shared/labels'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { LEVEL_GLYPH } from './levelGlyph'
import { resolveCreateTarget } from './placement'
import { useTreeStore } from './treeStore'

const BUTTON =
  'flex items-center rounded px-1 py-0.5 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:text-fg disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * The create buttons under the tree (F-2.2): one small plus per hierarchy level, scene first,
 * placed relative to the selection. A button disables when there is nowhere valid to put that
 * level (outside the manuscript, or a missing intermediate level) or while a request is in flight.
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
    <div className="flex shrink-0 items-center justify-end gap-0.5 border-t border-line px-1.5 py-1">
      {[...HIERARCHY_LEVELS].reverse().map((level) => {
        const { icon: Icon, color } = LEVEL_GLYPH[level]
        const label = `New ${levelLabel(format, level).toLowerCase()}`
        return (
          <button
            key={level}
            type="button"
            aria-label={label}
            title={label}
            disabled={busy || !enabled[HIERARCHY_LEVELS.indexOf(level)]}
            onClick={() => void onCreate(level)}
            className={BUTTON}
          >
            <Plus size={10} aria-hidden="true" strokeWidth={3} />
            <Icon size={13} aria-hidden="true" className={color} />
          </button>
        )
      })}
    </div>
  )
}
