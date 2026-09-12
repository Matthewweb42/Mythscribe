import { createElement, type ReactNode } from 'react'
import { Type, type LucideIcon } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { EditorSettingsTab } from '@renderer/features/editor/EditorSettingsTab'

/** The ids of the Settings dialog tabs (F-7.5). Not persisted: the dialog opens on the first. */
export type SettingsDialogTabId = 'editor'

/** One entry of the Settings dialog's tab bar (F-7.5). */
export interface SettingsDialogTab {
  id: SettingsDialogTabId
  label: string
  icon: LucideIcon
  /** The tab's panel content; the panel scrolls with the dialog. */
  render: (format: NovelFormat) => ReactNode
}

/**
 * The registry of built Settings tabs, in display order (F-7.5). Only the tabs that exist are
 * listed, so there is never a placeholder to click: the AI tab (F-5.1) appends its entry here
 * when it lands.
 */
export const SETTINGS_DIALOG_TABS: readonly [SettingsDialogTab, ...SettingsDialogTab[]] = [
  {
    id: 'editor',
    label: 'Editor',
    icon: Type,
    render: (format) => createElement(EditorSettingsTab, { format })
  }
]
