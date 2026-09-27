import { useState } from 'react'
import { LayoutGrid, List, MoreHorizontal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENTITY_KIND_LABEL, ENTITY_KIND_NOUN, type EntityKind } from '@shared/entities'
import { ENTITY_EXCHANGE_LABEL, type EntityExchangeFormat } from '@shared/entityExchange'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
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

/** The export items of the More menu (F-9.5): one per format, in one order. */
const EXPORT_FORMATS: readonly EntityExchangeFormat[] = ['json', 'csv']
/** `export:<format>` is the menu item id; `import` is the third. */
const EXPORT_PREFIX = 'export:'

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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
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

  // F-9.5: the tab's own export and import. Export needs something to export, so both items are
  // shown and disabled while the kind is empty; Import is always offered — that is how the first
  // entities of a reused library arrive.
  const menuItems: MenuItem[] = [
    ...EXPORT_FORMATS.map((format) => ({
      id: `${EXPORT_PREFIX}${format}`,
      label: `Export as ${ENTITY_EXCHANGE_LABEL[format]}…`,
      disabled: ofKind.length === 0
    })),
    { id: 'import', label: 'Import…' }
  ]

  const runMenuItem = async (itemId: string): Promise<void> => {
    const store = useEntityStore.getState()
    if (itemId === 'import') {
      await store.openImport(kind)
      return
    }
    const format = EXPORT_FORMATS.find((option) => `${EXPORT_PREFIX}${option}` === itemId)
    if (format === undefined) return
    const written = await store.exportKind(kind, format)
    // Null is the save dialog cancelled: nothing was written and nothing needs saying.
    if (written === null) return
    const name = written.path.split(/[\\/]/).pop() ?? written.path
    const noun = ENTITY_KIND_NOUN[kind]
    toast.success(
      `Exported ${written.count} ${written.count === 1 ? noun : `${noun}s`} to ${name}`
    )
  }

  const onMenuSelect = (itemId: string): void => {
    setMenu(null)
    runMenuItem(itemId).catch((err: unknown) => toast.error(describeError(err)))
  }

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
        <button
          type="button"
          aria-label="More"
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu((open) => (open ? null : { x: rect.left, y: rect.bottom }))
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
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
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  )
}
