import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import {
  settingsTabsFor,
  type SettingsDialogTab,
  type SettingsDialogTabId,
  type SettingsDialogTabs
} from '@renderer/features/shell/settingsDialogTabs'

interface SettingsDialogProps {
  /** The open project's format, or null on the welcome screen (only app-wide tabs then). */
  format: NovelFormat | null
  onClose: () => void
  /**
   * The tab to open on, when the opener named one (F-15.5: the low-credit notice opens Account).
   * Ignored when that tab is not among the visible ones, so the dialog always opens on something.
   */
  initialTab?: SettingsDialogTabId | null
  /** The tab registry; defaults to the built tabs for `format`. Injectable so tests can drive several tabs. */
  tabs?: SettingsDialogTabs
}

/**
 * The Settings dialog (F-7.5): a modal over the app with one tab per built settings area,
 * opened from the header button, Ctrl+, or Tools › Settings; without a project it shows only
 * the app-wide tabs (F-15.2: Account). It owns nothing but the
 * active tab; each tab reads and writes its own store, so a change applies live behind the
 * dialog. Escape, the close button, and a click on the backdrop close it, like the confirm and
 * prompt modals in `DialogHost`; the active tab resets to the first one on every open. The tabs
 * are an ARIA tablist with a roving tabindex and automatic activation: ArrowLeft/ArrowRight
 * wrap, Home/End jump to the ends.
 */
export function SettingsDialog({
  format,
  onClose,
  initialTab = null,
  tabs = settingsTabsFor(format)
}: SettingsDialogProps): React.JSX.Element {
  const titleId = useId()
  const panelId = useId()
  const openOn =
    initialTab !== null && tabs.some((tab) => tab.id === initialTab) ? initialTab : tabs[0].id
  const [activeId, setActiveId] = useState<SettingsDialogTabId>(openOn)
  const buttons = useRef(new Map<SettingsDialogTabId, HTMLButtonElement>())
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  useEffect(() => {
    buttons.current.get(openOn)?.focus()
  }, [tabs, openOn])

  const register = (id: SettingsDialogTabId, element: HTMLButtonElement | null): void => {
    if (element) buttons.current.set(id, element)
    else buttons.current.delete(id)
  }

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.findIndex((tab) => tab.id === active.id)
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    setActiveId(target.id)
    buttons.current.get(target.id)?.focus()
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
        onKeyDown={onDialogKeyDown}
        className="flex max-h-[85vh] w-[640px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Settings
          </h2>
          <button
            type="button"
            aria-label="Close settings"
            title="Close"
            onClick={onClose}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div
          role="tablist"
          aria-label="Settings"
          onKeyDown={onTabsKeyDown}
          className="mt-3 flex shrink-0 border-b border-line px-5"
        >
          {tabs.map((tab) => (
            <SettingsTabButton
              key={tab.id}
              tab={tab}
              selected={tab.id === active.id}
              panelId={panelId}
              register={register}
              onSelect={setActiveId}
            />
          ))}
        </div>
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabElementId(panelId, active.id)}
          className="min-h-0 flex-1 overflow-y-auto p-5"
        >
          {active.scope === 'app' ? active.render() : format ? active.render(format) : null}
        </div>
      </div>
    </div>
  )
}

const tabElementId = (panelId: string, id: SettingsDialogTabId): string => `${panelId}-tab-${id}`

interface SettingsTabButtonProps {
  tab: SettingsDialogTab
  selected: boolean
  panelId: string
  register: (id: SettingsDialogTabId, element: HTMLButtonElement | null) => void
  onSelect: (id: SettingsDialogTabId) => void
}

function SettingsTabButton({
  tab,
  selected,
  panelId,
  register,
  onSelect
}: SettingsTabButtonProps): React.JSX.Element {
  const Icon = tab.icon
  return (
    <button
      ref={(element) => register(tab.id, element)}
      type="button"
      role="tab"
      id={tabElementId(panelId, tab.id)}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(tab.id)}
      className="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-fg-muted select-none hover:text-fg focus-visible:bg-surface focus-visible:outline-none aria-selected:border-accent aria-selected:text-fg"
    >
      <Icon size={14} aria-hidden="true" />
      <span>{tab.label}</span>
    </button>
  )
}
