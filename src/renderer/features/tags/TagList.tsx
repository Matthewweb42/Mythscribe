import { useShallow } from 'zustand/react/shallow'
import { useTagStore } from './tagStore'

/** "3 uses" / "1 use", as the tag rows show it. */
function usesLabel(count: number): string {
  return count === 1 ? '1 use' : `${count} uses`
}

interface TagListProps {
  /** The tags to show, in list order (the tab filters by category and search). */
  ids: string[]
  /** Whether the bank is empty (no tags at all) or only the filter is; picks the empty message. */
  filtered: boolean
  onSelect: (id: string) => void
}

/**
 * The tag rows of the Tags tab (F-4.2): a flat list of buttons, each with the color dot, the
 * kebab-cased name, and its usage count. Clicking a row opens its detail view.
 */
export function TagList({ ids, filtered, onSelect }: TagListProps): React.JSX.Element {
  const tags = useTagStore(useShallow((s) => ids.map((id) => s.byId[id])))
  if (ids.length === 0) {
    return (
      <p className="m-0 px-3 py-4 text-center text-xs text-fg-muted">
        {filtered ? 'No tags match.' : 'No tags yet.'}
      </p>
    )
  }
  return (
    <ul role="list" aria-label="Tags" className="m-0 list-none p-1">
      {tags.map((tag) =>
        tag ? (
          <li key={tag.id} role="listitem">
            <button
              type="button"
              onClick={() => onSelect(tag.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: tag.color }}
                className="size-2.5 shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>{' '}
              <span className="text-xs text-fg-subtle tabular-nums">
                {usesLabel(tag.usageCount)}
              </span>
            </button>
          </li>
        ) : null
      )}
    </ul>
  )
}
