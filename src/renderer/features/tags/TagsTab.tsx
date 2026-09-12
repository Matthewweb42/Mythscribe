import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CATEGORY_FILTERS, filterLabel, type CategoryFilter } from './categoryFilter'
import { TagDetail } from './TagDetail'
import { TagForm } from './TagForm'
import { TagList } from './TagList'
import { TemplateLoader } from './TemplateLoader'
import { useTagStore } from './tagStore'

const filterElementId = (filter: CategoryFilter): string => `tag-category-${filter}`

/**
 * The Tags tab of the sidebar (F-4.2): the category strip on top, then either the template row
 * (F-4.3), the search, the filtered list, and the create form, or the selected tag's detail
 * view. The filter, the query, and the selection are local: nothing else in the app reads them.
 * Picking a category closes the detail view so the selection can never point outside the
 * visible list.
 */
export function TagsTab(): React.JSX.Element {
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
        className="flex min-h-0 flex-1 flex-col"
      >
        {selected ? (
          <TagDetail
            tag={selected}
            onBack={() => setSelectedId(null)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <>
            <TemplateLoader />
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
              <TagList ids={visibleIds} filtered={total > 0} onSelect={setSelectedId} />
            </div>
            <TagForm key={filter} filter={filter} />
          </>
        )}
      </div>
    </>
  )
}
