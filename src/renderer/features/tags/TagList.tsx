import { useShallow } from 'zustand/react/shallow'
import type { Tag } from '@shared/ipc/contract'
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
  /** Clicking a row opens its detail view, or in select mode (F-4.9) toggles it. */
  onSelect: (id: string) => void
  /** Select mode (F-4.9): the checked ids; rows become checkboxes. Undefined outside it. */
  checked?: ReadonlySet<string>
}

const ROW =
  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none'

/** The color dot, the kebab-cased name, and the usage count every row shows. */
function RowBody({ tag }: { tag: Tag }): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden="true"
        style={{ backgroundColor: tag.color }}
        className="size-2.5 shrink-0 rounded-full"
      />
      <span className="min-w-0 flex-1 truncate">{tag.name}</span>{' '}
      <span className="text-xs text-fg-subtle tabular-nums">{usesLabel(tag.usageCount)}</span>
    </>
  )
}

/**
 * The tag rows of the Tags tab (F-4.2): a flat list of buttons, each with the color dot, the
 * kebab-cased name, and its usage count. Clicking a row opens its detail view. In select mode
 * (F-4.9) each row is a checkbox instead, so the bulk bar can act on the checked ones.
 */
export function TagList({ ids, filtered, onSelect, checked }: TagListProps): React.JSX.Element {
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
            {checked === undefined ? (
              <button type="button" onClick={() => onSelect(tag.id)} className={ROW}>
                <RowBody tag={tag} />
              </button>
            ) : (
              <label className={`${ROW} cursor-pointer`}>
                <input
                  type="checkbox"
                  checked={checked.has(tag.id)}
                  onChange={() => onSelect(tag.id)}
                  className="shrink-0"
                />
                <RowBody tag={tag} />
              </label>
            )}
          </li>
        ) : null
      )}
    </ul>
  )
}
