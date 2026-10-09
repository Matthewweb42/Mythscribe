import { FileText } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Tag } from '@shared/ipc/contract'
import { useEntityStore } from '@renderer/features/entities/entityStore'
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
  /** Double-click or F2 on a row (2026-10-07): open its detail with the name field ready to edit. */
  onRename?: (id: string) => void
  /** Select mode (F-4.9): the checked ids; rows become checkboxes. Undefined outside it. */
  checked?: ReadonlySet<string>
  /**
   * F-9.15, the Index: tag id → the sheet it points at. Those rows come first (the list is given
   * in that order) with a link to the sheet; the labels follow under their own caption.
   */
  records?: Readonly<Record<string, string>>
}

const CAPTION = 'px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase'

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
 * F-9.15 (the Index): a tag that points at a record carries "Open record" beside it, and when
 * the list has both kinds the records and the labels sit under their own captions.
 */
export function TagList({
  ids,
  filtered,
  onSelect,
  onRename,
  checked,
  records
}: TagListProps): React.JSX.Element {
  const tags = useTagStore(useShallow((s) => ids.map((id) => s.byId[id])))
  const both =
    records !== undefined &&
    ids.some((id) => records[id] !== undefined) &&
    ids.some((id) => records[id] === undefined)
  const firstLabel = ids.find((id) => records?.[id] === undefined)
  if (ids.length === 0) {
    return (
      <p className="m-0 px-3 py-4 text-center text-xs text-fg-muted">
        {filtered ? 'No tags match.' : 'No tags yet.'}
      </p>
    )
  }
  return (
    <ul role="list" aria-label="Tags" className="m-0 list-none p-1">
      {tags.map((tag, index) => {
        if (!tag) return null
        const recordId = records?.[tag.id]
        const caption = !both
          ? null
          : index === 0
            ? 'Records'
            : tag.id === firstLabel
              ? 'Labels'
              : null
        return (
          <li key={tag.id} role="listitem">
            {caption === null ? null : (
              <div aria-hidden="true" className={CAPTION}>
                {caption}
              </div>
            )}
            {checked === undefined ? (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => onSelect(tag.id)}
                  onDoubleClick={() => onRename?.(tag.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'F2' || !onRename) return
                    event.preventDefault()
                    onRename(tag.id)
                  }}
                  className={ROW}
                >
                  <RowBody tag={tag} />
                </button>
                {recordId === undefined ? null : (
                  <button
                    type="button"
                    aria-label={`Open record #${tag.name}`}
                    title="Open record"
                    onClick={() => useEntityStore.getState().select(recordId)}
                    className="shrink-0 rounded-md p-1 text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:outline-none"
                  >
                    <FileText size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
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
        )
      })}
    </ul>
  )
}
