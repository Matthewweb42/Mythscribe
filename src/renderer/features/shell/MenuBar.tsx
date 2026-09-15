import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import type { NovelFormat } from '@shared/ipc/contract'
import {
  MENU,
  isMenuItemEnabled,
  isSeparator,
  menuItemChord,
  menuItemLabel,
  type MenuItem,
  type MenuSection,
  type MenuSectionId
} from '@shared/menu'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { runMenuAction } from '@renderer/features/shell/menuActions'
import { formatShortcut } from '@renderer/features/shell/shortcuts'

/**
 * The in-app menu bar (F-7.1), rendered from the same definition as the native menu and
 * dispatching every item through `runMenuAction`. An ARIA menubar: the six triggers are
 * `menuitem`s with a popup `menu`; a click or Enter/Space/ArrowDown opens one, hovering
 * another trigger while one is open switches, ArrowLeft/Right move between menus, ArrowUp/Down
 * (Home/End) move the focus among the open menu's items, Escape and an outside click close it,
 * and any other key closes it and goes through. Pressing a trigger or an item never moves the
 * focus (mousedown is prevented), so Edit › Paste lands in the editor or input that had it; only
 * arrowing into a menu focuses its items, and closing then puts the focus back where it was.
 * Items whose feature needs a project are `aria-disabled` without one; their shortcut text is
 * decorative (`aria-keyshortcuts` carries it), so a menu item's name is its label alone.
 */
export function MenuBar(): React.JSX.Element {
  const format = useProjectStore((s) => s.current?.format ?? null)
  const [openId, setOpenId] = useState<MenuSectionId | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  /** Mirrors `openId` for the callbacks, so opening knows whether the bar was closed before. */
  const openRef = useRef<MenuSectionId | null>(null)
  /** What had the focus when the menu opened, to give it back on close. */
  const restore = useRef<Element | null>(null)
  /** Set when a keyboard open wants the popup's first item focused once it renders. */
  const focusFirst = useRef(false)

  const close = useCallback((): void => {
    openRef.current = null
    setOpenId(null)
    const active = document.activeElement
    if (active && bar.current?.contains(active) && restore.current instanceof HTMLElement) {
      if (restore.current.isConnected) restore.current.focus()
    }
    restore.current = null
  }, [])

  const open = useCallback((id: MenuSectionId, withFocus: boolean): void => {
    if (openRef.current === null) restore.current = document.activeElement
    openRef.current = id
    focusFirst.current = withFocus
    setOpenId(id)
  }, [])

  useEffect(() => {
    if (openId === null || !focusFirst.current) return
    focusFirst.current = false
    itemButtons(bar.current, openId)[0]?.focus()
  }, [openId])

  const triggerButtons = (): HTMLButtonElement[] =>
    Array.from(bar.current?.querySelectorAll<HTMLButtonElement>('[data-menu-trigger]') ?? [])

  // While a menu is open the keys are handled here, wherever the focus is, and an outside
  // click closes it. Capture phase, and the handled keys stop, so nothing under the menu
  // (the editor, the focus-mode Escape listener) sees them.
  useEffect(() => {
    if (openId === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const index = MENU.findIndex((section) => section.id === openId)
      const items = itemButtons(bar.current, openId)
      const current = items.findIndex((button) => button === document.activeElement)
      const focusItem = (i: number): void => items[(i + items.length) % items.length]?.focus()
      switch (event.key) {
        case 'Escape':
          close()
          break
        case 'ArrowDown':
          focusItem(current + 1)
          break
        case 'ArrowUp':
          focusItem(current < 0 ? -1 : current - 1)
          break
        case 'Home':
          focusItem(0)
          break
        case 'End':
          focusItem(-1)
          break
        case 'ArrowRight':
          open(MENU[(index + 1) % MENU.length]!.id, true)
          break
        case 'ArrowLeft':
          open(MENU[(index - 1 + MENU.length) % MENU.length]!.id, true)
          break
        case 'Enter':
        case ' ':
          // On a focused item the button's own click runs it; anywhere else the key is swallowed.
          if (current >= 0) return
          break
        case 'Tab':
          close()
          return
        default:
          // Typing closes the menu and goes on to whatever has the focus.
          close()
          return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    const onMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.target instanceof Node && bar.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [openId, open, close])

  /** Keys on a trigger while nothing is open: arrows move along the bar, Enter/Space/Down open. */
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: MenuSectionId): void => {
    if (openId !== null) return
    const triggers = triggerButtons()
    const index = triggers.findIndex((button) => button === event.currentTarget)
    switch (event.key) {
      case 'ArrowRight':
        triggers[(index + 1) % triggers.length]?.focus()
        break
      case 'ArrowLeft':
        triggers[(index - 1 + triggers.length) % triggers.length]?.focus()
        break
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        open(id, true)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const activate = (item: MenuItem): void => {
    if (!isMenuItemEnabled(item, format !== null)) return
    close()
    void runMenuAction(item.id)
  }

  return (
    <div
      ref={bar}
      role="menubar"
      aria-label="Application menu"
      data-testid="menu-bar"
      className="flex items-center gap-0.5 text-sm"
    >
      {MENU.map((section, index) => (
        <MenuTrigger
          key={section.id}
          section={section}
          format={format}
          open={openId === section.id}
          tabIndex={index === 0 ? 0 : -1}
          onToggle={() => (openId === section.id ? close() : open(section.id, false))}
          onHover={() => {
            if (openId !== null && openId !== section.id) open(section.id, false)
          }}
          onKeyDown={(event) => onTriggerKeyDown(event, section.id)}
          onActivate={activate}
        />
      ))}
    </div>
  )
}

/** The item buttons of the open popup, in order. */
function itemButtons(bar: HTMLElement | null, id: MenuSectionId): HTMLButtonElement[] {
  return Array.from(
    bar?.querySelectorAll<HTMLButtonElement>(`[data-menu-popup="${id}"] [role="menuitem"]`) ?? []
  )
}

const keepFocus = (event: MouseEvent): void => event.preventDefault()

interface MenuTriggerProps {
  section: MenuSection
  format: NovelFormat | null
  open: boolean
  tabIndex: number
  onToggle: () => void
  onHover: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onActivate: (item: MenuItem) => void
}

function MenuTrigger({
  section,
  format,
  open,
  tabIndex,
  onToggle,
  onHover,
  onKeyDown,
  onActivate
}: MenuTriggerProps): React.JSX.Element {
  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabIndex}
        data-menu-trigger={section.id}
        onMouseDown={keepFocus}
        onClick={onToggle}
        onMouseEnter={onHover}
        onKeyDown={onKeyDown}
        className="rounded-md px-2 py-1 text-fg-muted select-none hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:text-fg focus-visible:outline-none aria-expanded:bg-surface-raised aria-expanded:text-fg"
      >
        {section.label}
      </button>
      {open ? (
        <ul
          role="menu"
          aria-label={section.label}
          data-menu-popup={section.id}
          className="absolute top-full left-0 z-40 m-0 mt-1 min-w-52 list-none rounded-md border border-line bg-surface-raised p-1 shadow-panel"
        >
          {section.entries.map((entry, index) =>
            isSeparator(entry) ? (
              <li key={`sep-${index}`} role="separator" className="my-1 border-t border-line" />
            ) : (
              <MenuEntryButton
                key={entry.id}
                item={entry}
                format={format}
                onActivate={onActivate}
              />
            )
          )}
        </ul>
      ) : null}
    </div>
  )
}

interface MenuEntryButtonProps {
  item: MenuItem
  format: NovelFormat | null
  onActivate: (item: MenuItem) => void
}

function MenuEntryButton({ item, format, onActivate }: MenuEntryButtonProps): React.JSX.Element {
  const chord = menuItemChord(item)
  const shortcut = chord ? formatShortcut(chord) : null
  const enabled = isMenuItemEnabled(item, format !== null)
  return (
    <li role="none" className="m-0 p-0">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={enabled ? undefined : true}
        aria-keyshortcuts={shortcut ?? undefined}
        onMouseDown={keepFocus}
        onClick={() => onActivate(item)}
        className="flex w-full items-center justify-between gap-6 rounded px-2 py-1 text-left text-sm hover:bg-surface focus:bg-surface focus:outline-none aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
      >
        <span>{menuItemLabel(item, format)}</span>
        {shortcut ? (
          <span aria-hidden="true" className="text-xs text-fg-muted">
            {shortcut}
          </span>
        ) : null}
      </button>
    </li>
  )
}
