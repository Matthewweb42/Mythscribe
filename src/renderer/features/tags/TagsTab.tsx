import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CATEGORY_FILTERS, filterLabel, type CategoryFilter } from './categoryFilter'
import { TagBankActions } from './TagBankActions'
import { TagBulkBar } from './TagBulkBar'
import { TagDetail } from './TagDetail'
import { TagForm } from './TagForm'
import { TagList } from './TagList'
import { TemplateLoader } from './TemplateLoader'
import { useTagStore } from './tagStore'

/** How soon after a row opened the detail a double-click on it still renames that tag. */
const ROW_DOUBLE_CLICK_MS = 600

const filterElementId = (filter: CategoryFilter): string => `tag-category-${filter}`

/**
 * The Tags tab of the sidebar (F-4.2): the category strip on top, then either the template row
 * (F-4.3), the search, the filtered list, and the create form, or the selected tag's detail
 * view. The filter, the query, and the selection are local: nothing else in the app reads them.
 * Picking a category closes the detail view so the selection can never point outside the
 * visible list. A selection request from the store (F-4.6, "Open in Tag Manager" on a token)
 * opens that tag's detail view under All, then is consumed, so a later remount of the tab does
 * not replay it. Select mode (F-4.9) turns the rows into checkboxes and the create form into the
 * bulk bar; the checked set is pruned to the visible rows at render, so a bulk action never
 * touches a tag the category or the search hides.
 * Double-click or F2 on a row renames (2026-10-07): the detail opens with its name field focused
 * and selected, so the tag naming rules stay on the one rename path. The row's first click has
 * already swapped the list for the detail, so the double-click lands there; a double-click within
 * moments of a row opening the detail counts as the row's, and its second click does nothing else.
 */
export function TagsTab(): React.JSX.Element {
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusName, setFocusName] = useState(0)
  /** When a row click last opened the detail (ms), for a double-click whose second click lands on it. */
  const openedByRowAt = useRef<number | null>(null)
  const pending = useTagStore((s) => s.pendingSelection)
  const [seenToken, setSeenToken] = useState(0)
  if (pending !== null && pending.token !== seenToken) {
    setSeenToken(pending.token)
    setSelectedId(pending.id)
    setFocusName(0)
    setFilter('all')
  }
  useEffect(() => {
    if (pending !== null) useTagStore.getState().clearSelectionRequest()
  }, [pending])
  const buttons = useRef(new Map<CategoryFilter, HTMLButtonElement>())
  const selected = useTagStore((s) => (selectedId === null ? undefined : s.byId[selectedId]))
  const needle = query.trim().toLowerCase()
  const visibleIds = useTagStore(
    useShallow((s) =>
      s.ids.filter((id) => {
        const tag = s.byId[id]
        if (!tag) return false
        if (filter !== 'all' && tag.category !== filter) return false
        return needle.length === 0 || tag.name.includes(needle)
      })
    )
  )
  const total = useTagStore((s) => s.ids.length)
  const [selecting, setSelecting] = useState(false)
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const visible = new Set(visibleIds)
  const picked = checkedIds.filter((id) => visible.has(id))
  const pickedSet = new Set(picked)

  const toggleChecked = (id: string): void => {
    setCheckedIds(pickedSet.has(id) ? picked.filter((other) => other !== id) : [...picked, id])
  }

  const endSelecting = (): void => {
    setSelecting(false)
    setCheckedIds([])
  }

  const openFromRow = (id: string): void => {
    openedByRowAt.current = performance.now()
    setFocusName(0)
    setSelectedId(id)
  }

  const renameFromRow = (id: string): void => {
    openedByRowAt.current = null
    setSelectedId(id)
    setFocusName((n) => n + 1)
  }

  const justOpenedByRow = (): boolean => {
    const at = openedByRowAt.current
    return at !== null && performance.now() - at < ROW_DOUBLE_CLICK_MS
  }

  // The second click of a row's double-click lands on whatever of the detail is under the
  // pointer (Back, the color, the category); it must not act there.
  const swallowSecondClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.detail < 2 || !justOpenedByRow()) return
    event.preventDefault()
    event.stopPropagation()
  }

  const onPanelDoubleClick = (): void => {
    const rename = justOpenedByRow()
    openedByRowAt.current = null
    if (rename) setFocusName((n) => n + 1)
  }

  const pick = (next: CategoryFilter): void => {
    setFilter(next)
    setSelectedId(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = CATEGORY_FILTERS.indexOf(filter)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % CATEGORY_FILTERS.length
        break
      case 'ArrowLeft':
        next = (index - 1 + CATEGORY_FILTERS.length) % CATEGORY_FILTERS.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = CATEGORY_FILTERS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = CATEGORY_FILTERS[next]
    if (target === undefined) return
    pick(target)
    buttons.current.get(target)?.focus()
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Tag categories"
        onKeyDown={onKeyDown}
        className="flex shrink-0 flex-wrap gap-x-1 border-b border-line px-1 py-1"
      >
        {CATEGORY_FILTERS.map((entry) => (
          <button
            key={entry}
            ref={(element) => {
              if (element) buttons.current.set(entry, element)
              else buttons.current.delete(entry)
            }}
            type="button"
            role="tab"
            id={filterElementId(entry)}
            aria-selected={entry === filter}
            aria-controls="tag-category-panel"
            tabIndex={entry === filter ? 0 : -1}
            onClick={() => pick(entry)}
            className="rounded-md border-b-2 border-transparent px-1.5 py-0.5 text-xs font-medium text-fg-muted select-none hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:outline-none aria-selected:border-accent aria-selected:text-fg"
          >
            {filterLabel(entry)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="tag-category-panel"
        aria-labelledby={filterElementId(filter)}
        onMouseDownCapture={selected ? swallowSecondClick : undefined}
        onClickCapture={selected ? swallowSecondClick : undefined}
        onDoubleClick={selected ? onPanelDoubleClick : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {selected ? (
          <TagDetail
            tag={selected}
            focusName={focusName}
            onBack={() => setSelectedId(null)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <>
            {/* Select mode needs the height for its rows and bar, not the template row. */}
            {selecting ? null : <TemplateLoader bankEmpty={total === 0} />}
            <TagBankActions
              selecting={selecting}
              empty={total === 0}
              onToggleSelect={() => (selecting ? endSelecting() : setSelecting(true))}
            />
            <div className="shrink-0 px-2 pt-2">
              <input
                type="search"
                aria-label="Search tags"
                placeholder="Search tags"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-md border border-line bg-bg px-2 py-1 text-sm"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TagList
                ids={visibleIds}
                filtered={total > 0}
                onSelect={selecting ? toggleChecked : openFromRow}
                onRename={selecting ? undefined : renameFromRow}
                checked={selecting ? pickedSet : undefined}
              />
            </div>
            {selecting ? (
              <TagBulkBar
                ids={visibleIds.filter((id) => pickedSet.has(id))}
                visibleIds={visibleIds}
                onChange={setCheckedIds}
                onDone={endSelecting}
              />
            ) : (
              <TagForm key={filter} filter={filter} />
            )}
          </>
        )}
      </div>
    </>
  )
}
