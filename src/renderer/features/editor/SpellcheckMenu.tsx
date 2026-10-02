import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDictionaryStore } from './dictionaryStore'

const SUGGEST_PREFIX = 'suggest:'
const ADD_ID = 'add'
const NONE_ID = 'none'

interface OpenMenu {
  x: number
  y: number
  word: string
  suggestions: string[]
}

/** Where the last right-click landed and what had the focus then: the editable being spellchecked. */
interface LastClick {
  x: number
  y: number
  target: HTMLElement | null
}

/** The menu's items: the suggestions (or a disabled line when there are none), then the dictionary. */
function spellcheckMenuItems(suggestions: string[]): MenuItem[] {
  const items: MenuItem[] =
    suggestions.length > 0
      ? suggestions.map((label, n) => ({ id: `${SUGGEST_PREFIX}${n}`, label }))
      : [{ id: NONE_ID, label: 'No suggestions', disabled: true }]
  items.push({ id: ADD_ID, label: 'Add to project dictionary' })
  return items
}

/**
 * The spelling menu (F-3.11), mounted once while a project is open. Main sees the right-click on
 * a word the spellchecker underlined and sends `spellcheck:menu`; the event carries no position,
 * so a capture-phase `contextmenu` listener remembers where every right-click landed and which
 * editable had the focus. The menu opens there with the suggestions and `Add to project
 * dictionary`.
 *
 * The menu takes the focus while it is open (it is keyboard-operable), so every way out puts the
 * focus back on the remembered editable first: `replaceMisspelling` in main acts on the word
 * under the caret of the focused editable, and the selection inside a contenteditable or a
 * textarea survives the focus moving to a button and back.
 *
 * The wrapper lifts the menu above the modal dialogs, which have text fields of their own.
 */
export function SpellcheckMenu(): React.JSX.Element | null {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const last = useRef<LastClick>({ x: 0, y: 0, target: null })

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      // A right-click on a menu item is not a click in an editable; keep what was remembered.
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      const active = document.activeElement
      last.current = {
        x: event.clientX,
        y: event.clientY,
        target: active instanceof HTMLElement ? active : null
      }
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    const off = ipc().on('spellcheck:menu', ({ word, suggestions }) => {
      setMenu({ x: last.current.x, y: last.current.y, word, suggestions })
    })
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      off()
    }
  }, [])

  const close = useCallback((): void => {
    setMenu(null)
    const target = last.current.target
    if (target?.isConnected) target.focus({ preventScroll: true })
  }, [])

  if (menu === null) return null

  const onSelect = (id: string): void => {
    close()
    if (id === ADD_ID) {
      void useDictionaryStore.getState().add(menu.word)
      return
    }
    if (!id.startsWith(SUGGEST_PREFIX)) return
    const word = menu.suggestions[Number(id.slice(SUGGEST_PREFIX.length))]
    if (word === undefined) return
    ipc()
      .invoke('spellcheck:replace', { word })
      .catch((err: unknown) => toast.error(describeError(err)))
  }

  return (
    <div className="relative z-50">
      <ContextMenu
        x={menu.x}
        y={menu.y}
        items={spellcheckMenuItems(menu.suggestions)}
        onSelect={onSelect}
        onClose={close}
      />
    </div>
  )
}
