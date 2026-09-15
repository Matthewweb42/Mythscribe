import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import {
  APP_SHORTCUTS,
  EDITOR_SHORTCUTS,
  SHORTCUT_IDS,
  formatShortcut,
  type Chord,
  type ShortcutGroup
} from '@renderer/features/shell/shortcuts'

interface ShortcutsDialogProps {
  onClose: () => void
}

interface ShortcutRow {
  label: string
  chord: Chord
}

const APP_GROUP_LABEL: Record<ShortcutGroup, string> = { app: 'App', insert: 'Insert' }

/** The reference's tables in order: the app groups from the registry, then the editor's own chords. */
function shortcutTables(): { label: string; rows: ShortcutRow[] }[] {
  const groups = (['app', 'insert'] as const).map((group) => ({
    label: APP_GROUP_LABEL[group],
    rows: SHORTCUT_IDS.map((id) => APP_SHORTCUTS[id]).filter((s) => s.group === group)
  }))
  return [...groups, { label: 'Editor', rows: [...EDITOR_SHORTCUTS] }]
}

/**
 * Help › Keyboard shortcuts (F-7.7): every shortcut in the app, read from the registry (the
 * app-level chords, F-2.7) and the editor's static list, rendered by `formatShortcut` so the
 * chords read as the platform shows them. A modal like the Settings dialog: Escape, the close
 * button, and a click on the backdrop close it; the focus starts on the close button.
 */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): React.JSX.Element {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[85vh] w-[520px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close keyboard shortcuts"
            title="Close"
            onClick={onClose}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {shortcutTables().map((table) => (
            <table key={table.label} className="mb-4 w-full border-collapse text-sm">
              <caption className="pb-1 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
                {table.label}
              </caption>
              <tbody>
                {table.rows.map((row) => (
                  <tr
                    key={`${row.label}-${formatShortcut(row.chord)}`}
                    className="border-t border-line"
                  >
                    <th scope="row" className="py-1 pr-4 text-left font-normal">
                      {row.label}
                    </th>
                    <td className="py-1 text-right">
                      <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs">
                        {formatShortcut(row.chord)}
                      </kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </div>
  )
}
