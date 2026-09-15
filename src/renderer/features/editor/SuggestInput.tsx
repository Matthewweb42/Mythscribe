import { useId, useLayoutEffect, useRef, useState } from 'react'

interface SuggestInputProps {
  /** The visible label text; also the input's accessible name. */
  label: string
  value: string
  onChange: (value: string) => void
  /** The names to suggest; those starting with the typed text (case-insensitive) are listed. */
  options: string[]
  placeholder?: string
  disabled?: boolean
}

/** The options that start with `value` (case-insensitive, trimmed); every option for an empty value. */
function suggestions(options: string[], value: string): string[] {
  const needle = value.trim().toLowerCase()
  return options.filter((option) => option.toLowerCase().startsWith(needle))
}

const INPUT =
  'min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-px text-xs leading-5 disabled:opacity-50'

/**
 * A text input with autocomplete (F-4.5): typing opens a listbox of the options that start with
 * the text, ArrowDown/ArrowUp move the active option, Enter fills it in and closes, Escape and
 * blur close. Free text stays allowed: the value is whatever the input holds, and an option is
 * only a shortcut to it. Combobox ARIA, so the listbox and the active option are announced.
 * The listbox is fixed-positioned under the input, measured when it opens and again on typing,
 * scrolling, and resizing, so the scrolling metadata pane (F-14.3) never clips it.
 */
export function SuggestInput({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false
}: SuggestInputProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the open listbox sits in the viewport: just under the input, as wide as it. */
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 0 })
  const inputId = useId()
  const listId = useId()
  const matches = open ? suggestions(options, value) : []
  const expanded = matches.length > 0

  // Measured when the list opens and re-measured on every keystroke, scroll (any ancestor:
  // the metadata pane scrolls, F-14.3), and resize, so the fixed list stays under the input.
  useLayoutEffect(() => {
    if (!expanded) return
    const measure = (): void => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = { top: rect.bottom + 2, left: rect.left, width: rect.width }
      setAnchor((current) =>
        current.top === next.top && current.left === next.left && current.width === next.width
          ? current
          : next
      )
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [expanded, value])
  const activeIndex = expanded ? Math.min(active, matches.length - 1) : -1
  const optionId = (index: number): string => `${listId}-${index}`

  const pick = (name: string): void => {
    onChange(name)
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
      } else setActive(Math.min(activeIndex + 1, matches.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Enter') {
      const chosen = matches[activeIndex]
      if (chosen === undefined) return
      event.preventDefault()
      pick(chosen)
    } else if (event.key === 'Escape') {
      if (open) event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={inputId} className="w-16 shrink-0 text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeIndex < 0 ? undefined : optionId(activeIndex)}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={INPUT}
      />
      {expanded ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          style={anchor}
          className="fixed z-30 m-0 max-h-40 list-none overflow-y-auto rounded-md border border-line bg-surface-raised p-1 text-xs shadow-panel"
        >
          {matches.map((name, index) => (
            <li
              key={name}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActive(index)}
              // The input keeps focus through the click, so blur does not close the list first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(name)}
              className="cursor-pointer truncate rounded-md px-2 py-1 aria-selected:bg-surface aria-selected:text-accent"
            >
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
