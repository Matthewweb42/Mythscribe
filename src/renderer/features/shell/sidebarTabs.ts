import { createElement, type ReactNode } from 'react'
import { BookOpen, Tag, type LucideIcon } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarTabId } from '@shared/sidebarTabs'
import { ManuscriptTab } from '@renderer/features/manuscript/ManuscriptTab'
import { TagsTab } from '@renderer/features/tags/TagsTab'

/** One entry of the sidebar tab bar (F-7.3). */
export interface SidebarTab {
  id: SidebarTabId
  label: string
  icon: LucideIcon
  /** The tab's panel content; the panel is a column flex box, so it may fill and scroll. */
  render: (format: NovelFormat) => ReactNode
}

/**
 * The registry of built sidebar tabs, in display order (F-7.3). Only the tabs that exist are
 * listed, so there is never a placeholder to click: Characters, Settings, World, Outline, and
 * Timeline (F-9.x–F-11.x) insert their entry here, in `SIDEBAR_TAB_IDS` order, when they land.
 */
export const SIDEBAR_TABS: readonly [SidebarTab, ...SidebarTab[]] = [
  {
    id: 'manuscript',
    label: 'Manuscript',
    icon: BookOpen,
    render: (format) => createElement(ManuscriptTab, { format })
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: Tag,
    render: () => createElement(TagsTab)
  }
]
