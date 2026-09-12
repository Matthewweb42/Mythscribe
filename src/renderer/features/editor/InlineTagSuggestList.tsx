import { useImperativeHandle, useState, type Ref } from 'react'
import { Plus } from 'lucide-react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import type { InlineTagAttrs, SuggestItem } from './InlineTag'

export interface InlineTagSuggestListProps {
  items: SuggestItem[]
  /** True while the plugin resolves the rows for a new query; nothing renders until they arrive. */
  loading: boolean
  /** Inserts the token for the picked tag and links it (the plugin's `command`). */
  command: (attrs: InlineTagAttrs) => void
}

/** What the plugin's key handler reaches: every key but Escape, which the plugin keeps. */
export interface InlineTagSuggestListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

/**
 * The `#` popup (F-4.6): a listbox of the matching bank tags with their color dots and, when the
 * typed text names no existing tag, a "Create" row. ArrowUp/ArrowDown move the active row and
 * wrap; Tab and Enter pick it; a click picks too, without taking focus from the editor. Picking
 * the Create row first creates a custom tag from the text and inserts the stored (kebab-cased)
 * result; a failed create toasts and leaves the text as typed. Keys arrive from the plugin
 * through the imperative handle, since the editor keeps focus while the list is open.
 */
export function InlineTagSuggestList({
  items,
  loading,
  command,
  ref
}: InlineTagSuggestListProps & {
  ref?: Ref<InlineTagSuggestListHandle>
}): React.JSX.Element | null {
  const [active, setActive] = useState(0)
  // A new query brings a new list: the highlight returns to the first row, so a row the pointer
  // happened to rest on while the list was long cannot survive as the pick for a narrower list.
  const [seen, setSeen] = useState(items)
  if (seen !== items) {
    setSeen(items)
    setActive(0)
  }
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1)

  const pick = (item: SuggestItem): void => {
    if (item.kind === 'tag') {
      command({ id: item.tag.id, name: item.tag.name })
      return
    }
    useTagStore
      .getState()
      .create({ name: item.name, category: 'custom' })
      .then((tag) => command({ id: tag.id, name: tag.name }))
      .catch((err: unknown) => toast.error(describeError(err)))
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return false
      if (event.key === 'ArrowDown') {
        setActive((activeIndex + 1) % items.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setActive((activeIndex - 1 + items.length) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const chosen = items[activeIndex]
        if (chosen) pick(chosen)
        return true
      }
      return false
    }
  }))

  if (items.length === 0) return null

  return (
    <ul
      role="listbox"
      aria-label="Tag suggestions"
      aria-busy={loading}
      className="relative z-30 m-0 max-h-48 w-64 list-none overflow-y-auto rounded-md border border-line bg-surface-raised p-1 font-ui text-sm shadow-panel"
    >
      {items.map((item, index) => (
        <li
          key={item.kind === 'tag' ? item.tag.id : `create:${item.name}`}
          role="option"
          aria-selected={index === activeIndex}
          // Movement, not entry: a list that opens under a resting pointer keeps its first row.
          onMouseMove={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(item)}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 aria-selected:bg-surface aria-selected:text-accent"
        >
          {item.kind === 'tag' ? (
            <>
              <span
                aria-hidden="true"
                style={{ backgroundColor: item.tag.color }}
                className="size-2.5 shrink-0 rounded-full"
              />
              <span className="min-w-0 flex-1 truncate">{item.tag.name}</span>
            </>
          ) : (
            <>
              <Plus size={12} aria-hidden="true" className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">Create #{item.name}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
