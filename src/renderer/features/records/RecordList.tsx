import { useShallow } from 'zustand/react/shallow'
import { entityImageUrl } from '@shared/entities'
import { AiMark } from '@renderer/features/ai/AiMark'
import { useCategory } from '@renderer/features/entities/categoryStore'
import { sceneCounts, useNameMentionStore } from './nameMentionStore'
import { useRecordStore } from './recordStore'
import { namedInLabel, nicknamesOf } from './recordView'

interface RecordListProps {
  categoryId: string
  /** The records to show, in list order (the tab filters by its search box). */
  ids: string[]
  /** Whether the category has records at all (only the search hides them); picks the empty message. */
  filtered: boolean
  /**
   * A note per record in place of "named in N scenes" (F-16.22: a secret's "readers since 5.2 · 3
   * know"; secrets are not names, so the scan never counts them).
   */
  notes?: Readonly<Record<string, string>> | null
}

/**
 * The rows of a category's section in story memory v2 (F-16.6): one per record, with its image
 * thumb, its name (with the AI mark on a secret or thread the reader found), its nicknames and
 * "named in N scenes" (from the local name scan; a secret's own note instead). Clicking a row
 * opens its sheet in the main pane; clicking the open one closes it.
 */
export function RecordList({
  categoryId,
  ids,
  filtered,
  notes = null
}: RecordListProps): React.JSX.Element {
  const records = useRecordStore(useShallow((s) => ids.flatMap((id) => s.byId[id] ?? [])))
  const selectedId = useRecordStore((s) => s.selectedId)
  const select = useRecordStore((s) => s.select)
  const scenes = useNameMentionStore(useShallow((s) => sceneCounts(s.namedIn)))
  const category = useCategory(categoryId)
  const plural = category.name.toLowerCase()

  if (records.length === 0) {
    return (
      <p className="m-0 px-3 py-4 text-center text-xs text-fg-muted">
        {filtered ? `No ${plural} match.` : `No ${plural} yet.`}
      </p>
    )
  }
  return (
    <ul role="list" aria-label={category.name} className="m-0 list-none p-1">
      {records.map((record) => {
        const selected = record.id === selectedId
        const nicknames = nicknamesOf(record).map((entry) => entry.text)
        return (
          <li key={record.id} role="listitem">
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => select(selected ? null : record.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none aria-[current]:bg-surface-raised"
            >
              {record.image === null ? (
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line text-xs text-fg-muted"
                >
                  {record.name.slice(0, 1).toUpperCase()}
                </span>
              ) : (
                <img
                  src={entityImageUrl(record.image)}
                  alt=""
                  className="size-7 shrink-0 rounded-md object-cover"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 truncate">{record.name}</span>
                  {record.origin === 'ai' ? <AiMark title="Found by the AI in your book" /> : null}
                </span>
                {nicknames.length > 0 ? (
                  <span className="min-w-0 truncate text-xs text-fg-muted">
                    {nicknames.join(', ')}
                  </span>
                ) : null}
                <span className="text-[11px] text-fg-subtle">
                  {notes === null ? namedInLabel(scenes[record.id] ?? 0) : (notes[record.id] ?? '')}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
