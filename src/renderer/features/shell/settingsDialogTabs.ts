import { createElement, type ReactNode } from 'react'
import {
  Activity,
  Archive,
  BookMarked,
  Download,
  Monitor,
  SlidersHorizontal,
  Sparkles,
  Type,
  UserRound,
  type LucideIcon
} from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { AccountSettingsTab } from '@renderer/features/account/AccountSettingsTab'
import { AiSettingsTab } from '@renderer/features/ai/AiSettingsTab'
import { BackupsSettingsTab } from '@renderer/features/backups/BackupsSettingsTab'
import { DiagnosticsSettingsTab } from '@renderer/features/diagnostics/DiagnosticsSettingsTab'
import { AdvancedSettingsTab } from '@renderer/features/devtools/AdvancedSettingsTab'
import { EditorSettingsTab } from '@renderer/features/editor/EditorSettingsTab'
import { StoryBibleSettingsTab } from '@renderer/features/entities/StoryBibleSettingsTab'
import { UpdatesSettingsTab } from '@renderer/features/updates/UpdatesSettingsTab'
import { AppearanceSettingsTab } from './AppearanceSettingsTab'

/** The ids of the Settings dialog tabs (F-7.5). Not persisted: the dialog opens on the first. */
export type SettingsDialogTabId =
  | 'editor'
  | 'ai'
  | 'storyBible'
  | 'backups'
  | 'appearance'
  | 'account'
  | 'updates'
  | 'diagnostics'
  | 'advanced'

interface SettingsDialogTabBase {
  id: SettingsDialogTabId
  label: string
  icon: LucideIcon
}

/**
 * One entry of the Settings dialog's tab bar (F-7.5). A `project` tab reads the open project's
 * settings and needs its format; an `app` tab is app-wide (F-15.2: the account) and is the only
 * kind shown when the dialog opens from the welcome screen.
 */
export type SettingsDialogTab =
  | (SettingsDialogTabBase & { scope: 'project'; render: (format: NovelFormat) => ReactNode })
  | (SettingsDialogTabBase & { scope: 'app'; render: () => ReactNode })

export type SettingsDialogTabs = readonly [SettingsDialogTab, ...SettingsDialogTab[]]

/**
 * The registry of built Settings tabs, in display order (F-7.5). Only the tabs that exist are
 * listed, so there is never a placeholder to click. The AI tab (F-5.1) holds the provider and
 * key with the dial, presets, and behaviour (F-14.4, F-5.2); the Account tab (F-15.2) the
 * optional MythScribe account; the Updates tab (F-15.7) the channel and the update state; the
 * Diagnostics tab (F-15.8) the opt-in crash and usage reports, which install off. The Appearance
 * tab (F-7.10) is app-wide, so the interface size can be fixed from the welcome screen. The
 * Backups tab (F-8.4) is app-wide too: its settings apply to every project, and a backup can be
 * restored with no project open.
 */
export const SETTINGS_DIALOG_TABS: SettingsDialogTabs = [
  {
    id: 'editor',
    label: 'Editor',
    icon: Type,
    scope: 'project',
    render: (format) => createElement(EditorSettingsTab, { format })
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Sparkles,
    scope: 'project',
    render: () => createElement(AiSettingsTab)
  },
  {
    // F-9.19: the category fields, the Blank page's write-up style, and the view new sheets open in.
    id: 'storyBible',
    label: 'Story bible',
    icon: BookMarked,
    scope: 'project',
    render: () => createElement(StoryBibleSettingsTab)
  },
  {
    id: 'backups',
    label: 'Backups',
    icon: Archive,
    scope: 'app',
    render: () => createElement(BackupsSettingsTab)
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Monitor,
    scope: 'app',
    render: () => createElement(AppearanceSettingsTab)
  },
  {
    id: 'account',
    label: 'Account',
    icon: UserRound,
    scope: 'app',
    render: () => createElement(AccountSettingsTab)
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: Download,
    scope: 'app',
    render: () => createElement(UpdatesSettingsTab)
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    icon: Activity,
    scope: 'app',
    render: () => createElement(DiagnosticsSettingsTab)
  },
  {
    // 2026-10-07: the developer tools switch; app-wide, so it works from the welcome screen too.
    id: 'advanced',
    label: 'Advanced',
    icon: SlidersHorizontal,
    scope: 'app',
    render: () => createElement(AdvancedSettingsTab)
  }
]

/** The tabs the dialog shows: all of them with a project open, only the app-wide ones without. */
export function settingsTabsFor(
  format: NovelFormat | null,
  tabs: SettingsDialogTabs = SETTINGS_DIALOG_TABS
): SettingsDialogTabs {
  if (format !== null) return tabs
  const app = tabs.filter((tab) => tab.scope === 'app')
  const [first, ...rest] = app
  if (first === undefined) throw new Error('The Settings dialog needs at least one app-wide tab')
  return [first, ...rest]
}
