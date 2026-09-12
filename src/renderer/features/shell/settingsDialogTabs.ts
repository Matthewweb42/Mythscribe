import { createElement, type ReactNode } from 'react'
import { Sparkles, Type, type LucideIcon } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { AiSettingsTab } from '@renderer/features/ai/AiSettingsTab'
import { EditorSettingsTab } from '@renderer/features/editor/EditorSettingsTab'

/** The ids of the Settings dialog tabs (F-7.5). Not persisted: the dialog opens on the first. */
export type SettingsDialogTabId = 'editor' | 'ai'

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
 * listed, so there is never a placeholder to click. The AI tab (F-5.1) holds the provider and
 * key; the enable toggle, presets, and behaviour join it with F-14.4 and F-5.2.
 */
export const SETTINGS_DIALOG_TABS: readonly [SettingsDialogTab, ...SettingsDialogTab[]] = [
  {
    id: 'editor',
    label: 'Editor',
    icon: Type,
    render: (format) => createElement(EditorSettingsTab, { format })
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Sparkles,
    render: () => createElement(AiSettingsTab)
  }
]
