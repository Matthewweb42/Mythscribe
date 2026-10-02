import { Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENTITY_KIND_LABEL, ENTITY_KIND_NOUN, type EntityKind } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityStore } from './entityStore'
import { excerptOf, type EntityView } from './entityView'

interface EntityListProps {
  kind: EntityKind
  /** The entities to show, in list order (the tab filters by search and category). */
  ids: string[]
  /** Whether the kind has entities at all (only the filter hides them); picks the empty message. */
  filtered: boolean
  view: EntityView
}

/**
 * The rows of an entity tab (F-9.2): one per entity, as a compact line (list) or a card with the
 * excerpt and, for world items, the category chip (cards). Clicking a row selects it (the
 * selection is store state F-9.3 opens in the editor); the trailing button deletes it after a
 * confirmation. The list is the one place both views are drawn, so they never drift apart.
 */
export function EntityList({ kind, ids, filtered, view }: EntityListProps): React.JSX.Element {
  const entities = useEntityStore(useShallow((s) => ids.map((id) => s.byId[id])))
  const selectedId = useEntityStore((s) => s.selectedId)
  const select = useEntityStore((s) => s.select)
  const remove = useEntityStore((s) => s.remove)

  const onDelete = async (entity: Entity): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${entity.name}"?`,
      message: `This removes the ${ENTITY_KIND_NOUN[kind]} and everything written on its page. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await remove(entity.id)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  if (ids.length === 0) {
    return (
      <p className="m-0 px-3 py-4 text-center text-xs text-fg-muted">
        {filtered
          ? `No ${ENTITY_KIND_LABEL[kind].toLowerCase()} match.`
          : `No ${ENTITY_KIND_LABEL[kind].toLowerCase()} yet.`}
      </p>
    )
  }
  return (
    <ul
      role="list"
      aria-label={ENTITY_KIND_LABEL[kind]}
      className={`m-0 list-none p-1 ${view === 'cards' ? 'flex flex-col gap-1' : ''}`}
    >
      {entities.map((entity) => {
        if (!entity) return null
        const excerpt = view === 'cards' ? excerptOf(entity) : ''
        const category = view === 'cards' && kind === 'world' ? entity.fields.category : undefined
        const selected = entity.id === selectedId
        return (
          <li key={entity.id} role="listitem" className="group relative">
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => select(selected ? null : entity.id)}
              className={`flex w-full min-w-0 flex-col rounded-md py-1 pr-8 pl-2 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none aria-[current]:bg-surface-raised ${view === 'cards' ? 'border border-line' : ''}`}
            >
              <span className={`min-w-0 truncate ${view === 'cards' ? 'font-medium' : ''}`}>
                {entity.name}
              </span>
              {entity.origin === 'ai' ? (
                <span className="mt-0.5 w-fit rounded-full border border-line px-1.5 text-[11px] text-fg-muted">
                  Added by AI
                </span>
              ) : null}
              {category !== undefined && category.length > 0 ? (
                <span className="mt-0.5 w-fit max-w-full truncate rounded-full border border-line px-1.5 text-[11px] text-fg-muted">
                  {category}
                </span>
              ) : null}
              {excerpt.length > 0 ? (
                <span className="mt-0.5 line-clamp-2 text-xs wrap-anywhere text-fg-muted">
                  {excerpt}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={`Delete ${entity.name}`}
              onClick={() => void onDelete(entity)}
              className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-fg-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
