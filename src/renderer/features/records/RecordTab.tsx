import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useCategory } from '@renderer/features/entities/categoryStore'
import { RecordList } from './RecordList'
import { recordsIn, useRecordStore } from './recordStore'
import { matchesRecordQuery } from './recordView'

/**
 * One category's section of the sidebar in story memory v2 (F-16.6): the search box (names and
 * nicknames), the records of the category, and *New …* at the foot, which opens the creation
 * dialog with its twin-gate warning. Kept beside v1's `EntityTab`, which v2 never shows.
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
        <RecordList categoryId={categoryId} ids={visibleIds} filtered={records.length > 0} />
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
