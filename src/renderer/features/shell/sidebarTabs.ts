import { createElement, type ReactNode } from 'react'
import { BookOpen, Globe, MapPin, Tag, Users, type LucideIcon } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarTabId } from '@shared/sidebarTabs'
import { EntityTab } from '@renderer/features/entities/EntityTab'
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
 * listed, so there is never a placeholder to click: Outline and Timeline (F-10.x/F-11.x) insert
 * their entry here, in `SIDEBAR_TAB_IDS` order, when they land. The three entity tabs (F-9.2)
 * are one component told apart by kind.
 */
export const SIDEBAR_TABS: readonly [SidebarTab, ...SidebarTab[]] = [
  {
    id: 'manuscript',
    label: 'Manuscript',
    icon: BookOpen,
    render: (format) => createElement(ManuscriptTab, { format })
  },
  {
    id: 'characters',
    label: 'Characters',
    icon: Users,
    render: () => createElement(EntityTab, { kind: 'character' })
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: MapPin,
    render: () => createElement(EntityTab, { kind: 'setting' })
  },
  {
    id: 'world',
    label: 'World',
    icon: Globe,
    render: () => createElement(EntityTab, { kind: 'world' })
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: Tag,
    render: () => createElement(TagsTab)
  }
]
