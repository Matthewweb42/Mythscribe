import { useMemo } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL } from '@shared/tags'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { tagFilterView } from './tagFilter'
import { useTreeStore } from './treeStore'

const FIELD = 'w-full min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/** "3 documents carry #dark-forest" / "1 document carries #dark-forest" / "No documents carry …". */
function countLabel(count: number, name: string): string {
  if (count === 0) return `No documents carry #${name}`
  if (count === 1) return `1 document carries #${name}`
  return `${count} documents carry #${name}`
}

/**
 * The tag filter above the document tree (F-4.10): picking a tag reloads every node ↔ tag link
 * and narrows the tree to the documents carrying it (with their ancestors for context); the
 * status line counts the matches and Clear filter restores the whole tree. Nothing renders while
 * the tag bank is empty. The filter itself lives in the tree store, so the Tag Manager's
 * "Show in tree" drives the same view.
 */
export function TagFilterBar(): React.JSX.Element | null {
  const ids = useTagStore((s) => s.ids)
  const byId = useTagStore((s) => s.byId)
  const tagFilterId = useTreeStore((s) => s.tagFilter)
  const setTagFilter = useTreeStore((s) => s.setTagFilter)
  const loadAll = useDocumentTagStore((s) => s.loadAll)
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const index = useTreeStore(
    useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf }))
  )
  const filterTag = tagFilterId === null ? undefined : byId[tagFilterId]
  const matchCount = useMemo(
    () => (filterTag ? tagFilterView(index, tagIdsByNode, filterTag.id).matches.length : 0),
    [index, tagIdsByNode, filterTag]
  )

  const pick = async (value: string): Promise<void> => {
    if (value === '') {
      setTagFilter(null)
      return
    }
    // Links can be made outside the per-document loads, so the map is refreshed with every pick;
    // a failed refresh still filters, on what the store already knows.
    try {
      await loadAll()
    } catch (err) {
      toast.error(describeError(err))
    }
    setTagFilter(value)
  }

  if (ids.length === 0) return null
  return (
    <div className="shrink-0 border-b border-line px-2 py-1">
      <div className="flex items-center gap-1">
        <select
          aria-label="Filter by tag"
          value={filterTag?.id ?? ''}
          onChange={(event) => void pick(event.target.value)}
          className={FIELD}
        >
          <option value="">All documents</option>
          {TAG_CATEGORIES.map((category) => {
            const inCategory = ids.filter((id) => byId[id]?.category === category)
            if (inCategory.length === 0) return null
            return (
              <optgroup key={category} label={TAG_CATEGORY_LABEL[category]}>
                {inCategory.map((id) => (
                  <option key={id} value={id}>
                    {byId[id]?.name}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        {filterTag ? (
          <button
            type="button"
            aria-label="Clear filter"
            onClick={() => setTagFilter(null)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {filterTag ? (
        <p className="m-0 mt-1 text-xs text-fg-muted">
          {countLabel(matchCount, filterTag.name)}
        </p>
      ) : null}
    </div>
  )
}
