import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { SECRET_CATEGORY_ID } from '@shared/memory/topics'
import { useCategory } from '@renderer/features/entities/categoryStore'
import { secretSummary } from '@renderer/features/memory/knows/knowsView'
import { useKnowsGrid } from '@renderer/features/memory/memoryStore'
import { RecordList } from './RecordList'
import { recordsIn, useRecordStore } from './recordStore'
import { matchesRecordQuery } from './recordView'

/**
 * One category's section of the sidebar in story memory v2 (F-16.6): the search box (names and
 * nicknames), the records of the category, and *New …* at the foot, which opens the creation
 * dialog with its twin-gate warning (none for a secret or thread, P2b-D19). Kept beside v1's
 * `EntityTab`, which v2 never shows. F-16.22: the Secrets section is this tab over `secret`.
 */
export function RecordTab({ categoryId }: { categoryId: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const category = useCategory(categoryId)
  const records = useRecordStore(useShallow((s) => recordsIn(s, categoryId)))
  const needle = query.trim().toLowerCase()
  const visibleIds = records
    .filter((record) => matchesRecordQuery(record, needle))
    .map((record) => record.id)
  const label = category.name.toLowerCase()
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2">
        <input
          type="search"
          aria-label={`Search ${label}`}
          placeholder={`Search ${label}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {categoryId === SECRET_CATEGORY_ID ? (
          <SecretList ids={visibleIds} filtered={records.length > 0} />
        ) : (
          <RecordList categoryId={categoryId} ids={visibleIds} filtered={records.length > 0} />
        )}
      </div>
      <div className="flex shrink-0 border-t border-line p-2">
        <button
          type="button"
          onClick={() => useRecordStore.getState().startCreate(categoryId)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <Plus size={12} aria-hidden="true" /> New {category.noun}…
        </button>
      </div>
    </>
  )
}

/**
 * F-16.22: the Secrets section's list, each secret with "readers since 5.2 · 3 know" as of the
 * end of the book (the who-knows-what grid's rows). An AI-made secret the grid does not hold is
 * revealed only where the reader no longer reads (another draft, an Idea or left-out scene) and
 * says so; nothing is said until the grid has loaded.
 */
function SecretList({ ids, filtered }: { ids: string[]; filtered: boolean }): React.JSX.Element {
  const grid = useKnowsGrid(null)
  const byId = useRecordStore((s) => s.byId)
  const notes = Object.fromEntries(
    ids.map((id) => [
      id,
      grid === undefined
        ? ''
        : secretSummary(
            grid.rows.find((row) => row.recordId === id),
            byId[id]?.origin === 'ai'
          )
    ])
  )
  return <RecordList categoryId={SECRET_CATEGORY_ID} ids={ids} filtered={filtered} notes={notes} />
}
