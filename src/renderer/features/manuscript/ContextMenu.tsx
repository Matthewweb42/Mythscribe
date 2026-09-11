import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MenuItem } from './contextMenuItems'

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * A fixed-position popup menu (F-2.2). Focus lands on the first item; arrows move, Enter/Space
 * choose, Escape and any outside click close it. The parent owns which items it lists.
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
    list.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && list.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
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
            role="menuitem"
            tabIndex={-1}
            onClick={() => onSelect(item.id)}
            className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-surface focus:bg-surface focus:outline-none"
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
