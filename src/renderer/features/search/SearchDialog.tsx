import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import {
  SEARCH_MAX_RESULTS,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  SEARCH_TYPES,
  SEARCH_TYPE_LABEL,
  isSearchable,
  normalizeQuery,
  type SearchRange,
  type SearchResult
} from '@shared/search'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { APP_SHORTCUTS, formatShortcut } from '@renderer/features/shell/shortcuts'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { jumpToResult } from './searchJump'
import { useSearchStore } from './searchStore'

/** Header action (F-10.1): opens the project search; Ctrl+Shift+F and Edit › Search project… do too. */
export function SearchButton(): React.JSX.Element {
  const openSearch = useSearchStore((s) => s.openSearch)
  const label = `Search project (${formatShortcut(APP_SHORTCUTS.search.chord)})`
  return (
    <button
      type="button"
      aria-label="Search project"
      title={label}
      onClick={openSearch}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
    >
      <Search size={16} aria-hidden="true" />
    </button>
  )
}

/** `text` with each range wrapped in `<mark>`; the accent pair reads in every theme and accent (F-7.8). */
function Highlighted({
  text,
  ranges
}: {
  text: string
  ranges: readonly SearchRange[]
}): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from < at || to > text.length) continue
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="rounded-sm bg-accent px-0.5 text-accent-fg">
        {text.slice(from, to)}
      </mark>
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/** Where the row's text lives: the parent or kind, and the entity field when the hit is in one. */
function locationLine(result: SearchResult): string {
  const type = result.type === 'notes' ? 'Notes' : null
  return [type, result.location, result.field].filter((part) => part).join(' · ')
}

/** The project search dialog (F-10.1), shown while the search store says it is open. */
export function SearchDialog(): React.JSX.Element | null {
  const open = useSearchStore((s) => s.open)
  return open ? <SearchDialogBody /> : null
}

/**
 * A command-palette style modal: the query box (focused, its text selected so a reopened search
 * is typed over), the type chips, the tag filter, and one row per matching source with its
 * highlighted snippet. ArrowUp/ArrowDown move the active row, Enter or a click jumps to it and
 * closes the dialog; Escape, the close button, and the backdrop close it.
 */
function SearchDialogBody(): React.JSX.Element {
  const titleId = useId()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const query = useSearchStore((s) => s.query)
  const types = useSearchStore((s) => s.types)
  const tagId = useSearchStore((s) => s.tagId)
  const response = useSearchStore((s) => s.response)
  const answeredQuery = useSearchStore((s) => s.answeredQuery)
  const status = useSearchStore((s) => s.status)
  const error = useSearchStore((s) => s.error)
  const close = useSearchStore((s) => s.close)
  const setQuery = useSearchStore((s) => s.setQuery)
  const toggleType = useSearchStore((s) => s.toggleType)
  const setTagId = useSearchStore((s) => s.setTagId)
  const tagIds = useTagStore((s) => s.ids)
  const tagsById = useTagStore((s) => s.byId)
  // The active row belongs to the answer it was chosen in: a new answer starts at its first row.
  const [active, setActiveRow] = useState({ response, index: 0 })

  const results = response?.results ?? []
  const activeIndex =
    active.response === response ? Math.min(active.index, Math.max(0, results.length - 1)) : 0
  const setActive = (index: number): void => setActiveRow({ response, index })
  const optionId = (index: number): string => `${listId}-${index}`

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  useEffect(() => {
    const row = list.current?.children[activeIndex]
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, response])

  const jump = (result: SearchResult): void => {
    close()
    jumpToResult(result, answeredQuery).catch((err: unknown) => toast.error(describeError(err)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + results.length) % results.length)
    } else if (event.key === 'Enter' && event.target === input.current) {
      const result = results[activeIndex]
      if (!result) return
      event.preventDefault()
      jump(result)
    }
  }

  const normalized = normalizeQuery(query)
  const message = !isSearchable(normalized)
    ? `Type at least ${SEARCH_QUERY_MIN} characters.`
    : types.length === 0
      ? 'Choose at least one type to search.'
      : status === 'error'
        ? (error ?? 'The search failed.')
        : status === 'done' && results.length === 0
          ? `No results for "${answeredQuery}".`
          : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="search-dialog"
        onKeyDown={onKeyDown}
        className="flex max-h-[70vh] w-[640px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h2 id={titleId} className="m-0 text-sm font-semibold">
            Search project
          </h2>
          <button
            type="button"
            aria-label="Close search"
            title="Close"
            onClick={close}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
          <input
            ref={input}
            type="search"
            role="searchbox"
            aria-label="Search the project"
            aria-controls={listId}
            aria-activedescendant={results.length > 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={SEARCH_QUERY_MAX}
            placeholder="Search documents, notes, and the story bible"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="Search in" className="flex flex-wrap gap-1.5">
              {SEARCH_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={types.includes(type)}
                  onClick={() => toggleType(type)}
                  className="rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-muted hover:text-fg aria-pressed:border-accent aria-pressed:text-fg"
                >
                  {SEARCH_TYPE_LABEL[type]}
                </button>
              ))}
            </div>
            <select
              aria-label="Filter by tag"
              value={tagId ?? ''}
              onChange={(event) => setTagId(event.target.value === '' ? null : event.target.value)}
              className="ml-auto max-w-[40%] rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-fg"
            >
              <option value="">Any tag</option>
              {tagIds.map((id) => (
                <option key={id} value={id}>
                  {tagsById[id]?.name ?? id}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {message !== null ? (
            <p role="status" className="m-0 px-4 py-4 text-sm text-fg-muted">
              {message}
            </p>
          ) : null}
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Search results"
            className="m-0 list-none p-0"
          >
            {results.map((result, index) => (
              <li
                key={`${result.type}:${result.id}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                data-testid={`search-result-${result.type}`}
                onMouseMove={() => {
                  if (index !== activeIndex) setActive(index)
                }}
                onClick={() => jump(result)}
                className="cursor-pointer border-b border-line px-4 py-2 text-sm last:border-b-0 aria-selected:bg-bg aria-selected:shadow-[inset_3px_0_0_var(--color-accent)]"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate font-medium">
                    <Highlighted text={result.title} ranges={result.titleHighlights} />
                  </span>
                  <span className="min-w-0 shrink truncate text-xs text-fg-muted">
                    {locationLine(result)}
                  </span>
                  {result.count > 1 ? (
                    <span className="ml-auto shrink-0 text-xs text-fg-muted">×{result.count}</span>
                  ) : null}
                </div>
                {result.snippet.text !== '' ? (
                  <p className="mt-0.5 mb-0 text-xs text-fg-muted">
                    <Highlighted text={result.snippet.text} ranges={result.snippet.highlights} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {response?.truncated ? (
            <p className="m-0 border-t border-line px-4 py-2 text-xs text-fg-muted">
              Showing the first {SEARCH_MAX_RESULTS} of {response.total}.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
