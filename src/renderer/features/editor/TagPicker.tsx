import { useEffect, useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tag } from '@shared/ipc/contract'
import { useTagStore } from '@renderer/features/tags/tagStore'

interface TagPickerProps {
  /** The tags already on the document; the picker offers every other tag of the bank. */
  excludeIds: string[]
  onPick: (tagId: string) => void
  onClose: () => void
}

/** The unassigned tags whose name contains `query` (case-insensitive), in bank order. */
function pickerOptions(tags: (Tag | undefined)[], excludeIds: string[], query: string): Tag[] {
  const needle = query.trim().toLowerCase()
  const excluded = new Set(excludeIds)
  return tags.filter(
    (tag): tag is Tag =>
      tag !== undefined && !excluded.has(tag.id) && tag.name.toLowerCase().includes(needle)
  )
}

/**
 * The "Add tag" popover of the tag bar (F-4.4): a search box over the tags not yet on the
 * document, as a listbox. ArrowUp/ArrowDown move the active option, Enter or a click picks it,
 * Escape or a click outside closes. Linking only; tags are created in the Tags tab, which the
 * empty state points to.
 */
export function TagPicker({ excludeIds, onPick, onClose }: TagPickerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const tags = useTagStore(useShallow((s) => s.ids.map((id) => s.byId[id])))
  const bankEmpty = useTagStore((s) => s.ids.length === 0)
  const options = pickerOptions(tags, excludeIds, query)
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1)
  const optionId = (index: number): string => `${listId}-${index}`

  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(activeIndex + 1, options.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = options[activeIndex]
      if (chosen) onPick(chosen.id)
    }
  }

  const empty = bankEmpty
    ? 'No tags yet. Create tags in the Tags tab of the sidebar.'
    : options.length === 0 && query.trim() === ''
      ? 'Every tag is already on this document.'
      : 'No tags match.'

  return (
    <div
      ref={root}
      role="group"
      aria-label="Add tag"
      className="absolute top-full right-0 z-30 mt-1 flex w-64 flex-col gap-1 rounded-md border border-line bg-surface-raised p-2 text-sm shadow-panel"
    >
      <input
        type="search"
        aria-label="Search tags"
        aria-controls={listId}
        aria-activedescendant={activeIndex < 0 ? undefined : optionId(activeIndex)}
        autoFocus
        value={query}
        placeholder="Search tags"
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-line bg-bg px-2 py-1 text-sm"
      />
      {options.length === 0 ? (
        <p className="m-0 px-1 py-2 text-xs text-fg-muted">{empty}</p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label="Unassigned tags"
          className="m-0 max-h-48 list-none overflow-y-auto p-0"
        >
          {options.map((tag, index) => (
            <li
              key={tag.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(tag.id)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 aria-selected:bg-surface aria-selected:text-accent"
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: tag.color }}
                className="size-2.5 shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
