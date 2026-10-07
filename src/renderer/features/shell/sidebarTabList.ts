import { createElement, type ReactNode } from 'react'
import {
  BookOpen,
  CalendarRange,
  FilePenLine,
  Globe,
  Library,
  ListTree,
  MapPin,
  Tag,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import type { SidebarTabId } from '@shared/sidebarTabs'
import { EditPassTab } from '@renderer/features/editPass/EditPassTab'
import { EntityTab } from '@renderer/features/entities/EntityTab'
import { LibraryTab } from '@renderer/features/library/LibraryTab'
import { ManuscriptTab } from '@renderer/features/manuscript/ManuscriptTab'
import { OutlineTab } from '@renderer/features/outline/OutlineTab'
import { TagsTab } from '@renderer/features/tags/TagsTab'
import { TimelineTab } from '@renderer/features/timeline/TimelineTab'

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
 * listed, so there is never a placeholder to click; every id of `SIDEBAR_TAB_IDS` is built now
 * (Timeline landed with F-11.2). The three entity tabs (F-9.2) are one component told apart by
 * kind.
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
    id: 'outline',
    label: 'Outline',
    icon: ListTree,
    render: () => createElement(OutlineTab)
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: CalendarRange,
    render: () => createElement(TimelineTab)
  },
  {
    id: 'tags',
    label: 'Tags',
    icon: Tag,
    render: () => createElement(TagsTab)
  },
  {
    id: 'edits',
    label: 'Edits',
    icon: FilePenLine,
    render: () => createElement(EditPassTab)
  },
  {
    id: 'library',
    label: 'Library',
    icon: Library,
    render: () => createElement(LibraryTab)
  }
]
