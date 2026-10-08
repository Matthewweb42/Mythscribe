import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENTITY_NAME_MAX, type EntityKind } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { InlineRenameInput } from '@renderer/features/shell/InlineRenameInput'
import { describeError } from '@renderer/lib/errors'
import { useCategory, useCategoryStore } from './categoryStore'
import { useEntityDraftStore } from './entityDraftStore'
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
 * Double-click or F2 renames a row inline (2026-10-07); the open page's name goes through its
 * draft, so the page never writes the old name back.
 */
export function EntityList({ kind, ids, filtered, view }: EntityListProps): React.JSX.Element {
  const entities = useEntityStore(useShallow((s) => ids.map((id) => s.byId[id])))
  const selectedId = useEntityStore((s) => s.selectedId)
  const select = useEntityStore((s) => s.select)
  const remove = useEntityStore((s) => s.remove)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const category = useCategory(kind)
  const categories = useCategoryStore((s) => s.categories)
  const plural = category.name.toLowerCase()

  const rename = async (id: string, name: string): Promise<void> => {
    const drafts = useEntityDraftStore.getState()
    if (drafts.draft?.id === id) {
      drafts.edit({ name })
      await drafts.flush()
      return
    }
    await useEntityStore.getState().update(id, { name })
  }

  const onDelete = async (entity: Entity): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${entity.name}"?`,
      message: `This removes the ${category.noun} and everything written on its page. This cannot be undone.`,
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
        {filtered ? `No ${plural} match.` : `No ${plural} yet.`}
      </p>
    )
  }
  return (
    <ul
      role="list"
      aria-label={category.name}
      className={`m-0 list-none p-1 ${view === 'cards' ? 'flex flex-col gap-1' : ''}`}
    >
      {entities.map((entity) => {
        if (!entity) return null
        const excerpt = view === 'cards' ? excerptOf(entity, categories) : ''
        const chip = view === 'cards' && kind === 'world' ? entity.fields.category : undefined
        const selected = entity.id === selectedId
        if (entity.id === renamingId) {
          return (
            <li key={entity.id} role="listitem" className="flex py-1 pr-1 pl-2">
              <InlineRenameInput
                value={entity.name}
                maxLength={ENTITY_NAME_MAX}
                onCommit={(next) => rename(entity.id, next)}
                onDone={() => setRenamingId(null)}
              />
            </li>
          )
        }
        return (
          <li key={entity.id} role="listitem" className="group relative">
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={(event) => {
                // The second click of a double-click must not close the page the first opened.
                if (event.detail > 1) return
                select(selected ? null : entity.id)
              }}
              onDoubleClick={() => setRenamingId(entity.id)}
              onKeyDown={(event) => {
                if (event.key !== 'F2') return
                event.preventDefault()
                setRenamingId(entity.id)
              }}
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
              {chip !== undefined && chip.length > 0 ? (
                <span className="mt-0.5 w-fit max-w-full truncate rounded-full border border-line px-1.5 text-[11px] text-fg-muted">
                  {chip}
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
