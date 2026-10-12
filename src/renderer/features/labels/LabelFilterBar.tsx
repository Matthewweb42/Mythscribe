import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { labelCountLabel, useLabelFilterView } from './labelFilter'
import { filterLabelOf, useLabelStore, type LabelSurface } from './labelStore'

const FIELD = 'w-full min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The label filter above a tree or the Outline (F-16.7, story memory v2): picking a label
 * narrows the view to the scenes or documents carrying it, with their folders for context; the
 * line under it counts them and × clears it. Nothing renders while there are no labels.
 */
export function LabelFilterBar({ surface }: { surface: LabelSurface }): React.JSX.Element | null {
  const labels = useLabelStore((s) => s.labels)
  const filterLabel = useLabelStore((s) => filterLabelOf(s, surface))
  const setFilter = useLabelStore((s) => s.setFilter)
  const index = useTreeStore(useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf })))
  const view = useLabelFilterView(surface, index)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  // What the filtered view shows: the Manuscript tree holds front and end matter too, which may
  // carry labels; the Outline is the manuscript only; Research is its own tree.
  const shows = (id: string): boolean => {
    const section = sectionOf[id]
    if (surface === 'research') return section === 'research'
    if (surface === 'outline') return section === 'manuscript'
    return section !== undefined && section !== 'research'
  }
  const count = view === null ? 0 : [...view.matches].filter(shows).length

  if (labels.length === 0) return null
  return (
    <div className="shrink-0 border-b border-line px-2 py-1">
      <div className="flex items-center gap-1">
        <select
          aria-label="Filter by label"
          value={filterLabel?.id ?? ''}
          onChange={(event) =>
            setFilter(surface, event.target.value === '' ? null : event.target.value)
          }
          className={FIELD}
        >
          <option value="">All documents</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
        {filterLabel ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setFilter(surface, null)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {filterLabel ? (
        <p className="m-0 mt-1 text-xs text-fg-muted">{labelCountLabel(count, filterLabel.name)}</p>
      ) : null}
    </div>
  )
}
