import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { MenuItem } from './contextMenuItems'

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
}

/** The items focus and the arrows move between: a disabled item is shown but skipped. */
const CHOOSABLE = 'button:not(:disabled)'

/**
 * A fixed-position popup menu (F-2.2). Focus lands on the first item; arrows move, Enter/Space
 * choose, Escape and any outside click close it. The parent owns which items it lists, and may
 * mark one disabled (F-9.5), which keeps it visible and out of the keyboard's way.
 */
export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose
}: ContextMenuProps): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Nudge the menu back inside the viewport once its size is known.
  useLayoutEffect(() => {
    const rect = list.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width))
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height))
    setPosition({ left, top })
  }, [x, y])

  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>(CHOOSABLE)?.focus()
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && list.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>(CHOOSABLE) ?? [])
    const current = buttons.findIndex((button) => button === document.activeElement)
    switch (event.key) {
      case 'ArrowDown':
        buttons[(current + 1) % buttons.length]?.focus()
        break
      case 'ArrowUp':
        buttons[(current - 1 + buttons.length) % buttons.length]?.focus()
        break
      case 'Escape':
        onClose()
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <ul
      ref={list}
      role="menu"
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-40 m-0 min-w-40 list-none rounded-md border border-line bg-surface-raised p-1 shadow-panel"
    >
      {items.map((item) => (
        <li key={item.id} role="none" className="m-0 p-0">
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            tabIndex={-1}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onSelect(item.id)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-surface focus:bg-surface focus:outline-none disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {item.checked !== undefined ? (
              <Check
                size={14}
                aria-hidden="true"
                className={item.checked ? 'shrink-0' : 'shrink-0 opacity-0'}
              />
            ) : null}
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
