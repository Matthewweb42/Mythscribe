import { useEffect, useState } from 'react'
import type { SearchMisses as SearchMissesData } from '@shared/scribe'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How many of the newest misses Settings lists. */
export const SEARCH_MISSES_SHOWN = 5

/**
 * Settings › AI › Story memory › Details: **Search misses** (F-16.25, P3-D15; story memory v2):
 * how many passages the assistant only found by reading a whole chapter after its search had
 * missed them, then the newest few, each with the question, the passage found (its scene and
 * quote) and the words searched. Local and free (`scribe:searchMisses`); the count is what decides
 * whether the book needs meaning search (F-16.35).
 */
export function SearchMisses(): React.JSX.Element {
  const [misses, setMisses] = useState<SearchMissesData | null>(null)
  const titles = useTreeStore((s) => s.byId)
  const assistantName = useAssistantName()
  useEffect(() => {
    let live = true
    ipc()
      .invoke('scribe:searchMisses', { limit: SEARCH_MISSES_SHOWN })
      .then((answer) => {
        if (live) setMisses(answer)
      })
      .catch((err: unknown) => {
        if (live) toast.error(describeError(err))
      })
    return () => {
      live = false
    }
  }, [])
  if (misses === null) return <span className="text-xs text-fg-muted">Reading search misses…</span>
  return (
    <div data-testid="search-misses" className="flex flex-col gap-1">
      <span data-testid="search-misses-count">Search misses: {misses.count}</span>
      <span className="text-fg-subtle">
        Passages {assistantName} found only by reading a whole chapter, which the search had
        missed. Kept on this computer; never sent.
      </span>
      {misses.recent.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {misses.recent.map((miss) => (
            <li
              key={miss.id}
              data-testid="search-miss"
              className="rounded border border-line px-2 py-1"
            >
              <span className="block text-fg">“{miss.question}”</span>
              <span className="block">
                Found in {titles[miss.nodeId]?.title ?? 'a scene since deleted'} ¶{miss.para + 1}:{' '}
                <q className="italic">{miss.quote}</q>
              </span>
              <span className="block text-fg-subtle">
                {miss.terms.length === 0
                  ? 'No words were searched.'
                  : `Searched for: ${miss.terms.join(', ')}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
