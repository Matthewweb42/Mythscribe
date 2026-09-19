import { createElement, type ReactNode } from 'react'
import { Sparkles, Type, UserRound, type LucideIcon } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { AccountSettingsTab } from '@renderer/features/account/AccountSettingsTab'
import { AiSettingsTab } from '@renderer/features/ai/AiSettingsTab'
import { EditorSettingsTab } from '@renderer/features/editor/EditorSettingsTab'

/** The ids of the Settings dialog tabs (F-7.5). Not persisted: the dialog opens on the first. */
export type SettingsDialogTabId = 'editor' | 'ai' | 'account'

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
 * optional MythScribe account.
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
    id: 'account',
    label: 'Account',
    icon: UserRound,
    scope: 'app',
    render: () => createElement(AccountSettingsTab)
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
