import { useState } from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENTITY_KIND_LABEL, type EntityKind } from '@shared/entities'
import { EntityList } from './EntityList'
import { EntityQuickAdd } from './EntityQuickAdd'
import { useEntityStore } from './entityStore'
import {
  ALL_CATEGORIES,
  ENTITY_VIEWS,
  ENTITY_VIEW_LABEL,
  categoriesOf,
  matchesQuery,
  type EntityView
} from './entityView'

const VIEW_ICON: Record<EntityView, typeof List> = { list: List, cards: LayoutGrid }

/**
 * One entity tab of the sidebar (F-9.2): Characters, Settings, or World, told apart by `kind`.
 * The search box on top (name, fields, and page), the list/cards toggle beside it, the filtered
 * rows, and the quick-add form at the foot. The World tab adds a category filter once a category
 * is in use. The query and the category are local; the view and the selection live in the store
 * so they survive a switch to another sidebar tab.
 */
export function EntityTab({ kind }: { kind: EntityKind }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const view = useEntityStore((s) => s.view[kind])
  const setView = useEntityStore((s) => s.setView)
  const needle = query.trim().toLowerCase()
  const ofKind = useEntityStore(
    useShallow((s) =>
      s.ids.flatMap((id) => {
        const entity = s.byId[id]
        return entity?.kind === kind ? [entity] : []
      })
    )
  )
  const categories = kind === 'world' ? categoriesOf(ofKind) : []
  const activeCategory = categories.includes(category) ? category : ALL_CATEGORIES
  const visibleIds = ofKind
    .filter(
      (entity) =>
        activeCategory === ALL_CATEGORIES || entity.fields.category?.trim() === activeCategory
    )
    .filter((entity) => matchesQuery(entity, needle))
    .map((entity) => entity.id)
  const label = ENTITY_KIND_LABEL[kind]

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pt-2">
        <input
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder={`Search ${label.toLowerCase()}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
        <div role="group" aria-label="View" className="flex shrink-0 gap-0.5">
          {ENTITY_VIEWS.map((option) => {
            const Icon = VIEW_ICON[option]
            return (
              <button
                key={option}
                type="button"
                aria-label={ENTITY_VIEW_LABEL[option]}
                aria-pressed={option === view}
                onClick={() => setView(kind, option)}
                className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg"
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            )
          })}
        </div>
        {categories.length > 0 ? (
          <select
            aria-label="Category"
            value={activeCategory}
            onChange={(event) => setCategory(event.target.value)}
            className="w-full min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm"
          >
            <option value={ALL_CATEGORIES}>All categories</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EntityList kind={kind} ids={visibleIds} filtered={ofKind.length > 0} view={view} />
      </div>
      <EntityQuickAdd kind={kind} />
    </>
  )
}
