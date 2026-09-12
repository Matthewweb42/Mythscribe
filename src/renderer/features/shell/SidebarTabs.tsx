import { useRef } from 'react'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarTabId } from '@shared/sidebarTabs'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { SIDEBAR_TABS, type SidebarTab } from '@renderer/features/shell/sidebarTabs'

interface SidebarTabsProps {
  format: NovelFormat
  /** The tab registry; defaults to the built tabs. Injectable so tests can drive several tabs. */
  tabs?: readonly [SidebarTab, ...SidebarTab[]]
}

const tabElementId = (id: SidebarTabId): string => `sidebar-tab-${id}`

/**
 * The sidebar's tab bar and panel (F-7.3). The active tab is app-wide layout state; a persisted
 * id with no registered tab (a tab from a later build, or a hand-edited app-state file) falls
 * back to the first tab without touching the store. The tabs are an ARIA tablist with a roving
 * tabindex and automatic activation: ArrowLeft/ArrowRight wrap, Home/End jump to the ends.
 */
export function SidebarTabs({ format, tabs = SIDEBAR_TABS }: SidebarTabsProps): React.JSX.Element {
  const stored = useLayoutStore((s) => s.layout.sidebar.tab)
  const setSidebarTab = useLayoutStore((s) => s.setSidebarTab)
  const buttons = useRef(new Map<SidebarTabId, HTMLButtonElement>())
  const active = tabs.find((tab) => tab.id === stored) ?? tabs[0]

  const register = (id: SidebarTabId, element: HTMLButtonElement | null): void => {
    if (element) buttons.current.set(id, element)
    else buttons.current.delete(id)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
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
    setSidebarTab(target.id)
    buttons.current.get(target.id)?.focus()
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Sidebar"
        onKeyDown={onKeyDown}
        className="flex shrink-0 border-b border-line"
      >
        {tabs.map((tab) => (
          <SidebarTabButton
            key={tab.id}
            tab={tab}
            selected={tab.id === active.id}
            register={register}
            onSelect={setSidebarTab}
          />
        ))}
      </div>
      <div
        role="tabpanel"
        id="sidebar-tabpanel"
        aria-labelledby={tabElementId(active.id)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {active.render(format)}
      </div>
    </>
  )
}

interface SidebarTabButtonProps {
  tab: SidebarTab
  selected: boolean
  register: (id: SidebarTabId, element: HTMLButtonElement | null) => void
  onSelect: (id: SidebarTabId) => void
}

function SidebarTabButton({
  tab,
  selected,
  register,
  onSelect
}: SidebarTabButtonProps): React.JSX.Element {
  const Icon = tab.icon
  return (
    <button
      ref={(element) => register(tab.id, element)}
      type="button"
      role="tab"
      id={tabElementId(tab.id)}
      aria-selected={selected}
      aria-controls="sidebar-tabpanel"
      tabIndex={selected ? 0 : -1}
      title={tab.label}
      onClick={() => onSelect(tab.id)}
      className="flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 border-transparent px-2 py-1.5 text-xs font-medium text-fg-muted select-none hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:outline-none aria-selected:border-accent aria-selected:text-fg"
    >
      <Icon size={14} aria-hidden="true" />
      <span className="truncate">{tab.label}</span>
    </button>
  )
}
